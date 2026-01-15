const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Structure des données du jeu
const gameRooms = new Map();
const players = new Map();
const disconnectedPlayers = new Map(); // Pour la reconnexion

// Utilitaires
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/[<>]/g, '') // Supprimer les balises HTML
        .replace(/[&]/g, '&amp;')
        .replace(/["']/g, '')
        .trim()
        .substring(0, 30); // Limiter la longueur
}

function logInfo(message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`, data);
}

function logError(message, error = null) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, error);
}

// Rate limiting map
const rateLimits = new Map();

function checkRateLimit(socketId, eventType, maxEvents = 50, windowMs = 1000) {
    const key = `${socketId}-${eventType}`;
    const now = Date.now();

    if (!rateLimits.has(key)) {
        rateLimits.set(key, { count: 1, resetTime: now + windowMs });
        return true;
    }

    const limit = rateLimits.get(key);

    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + windowMs;
        return true;
    }

    if (limit.count >= maxEvents) {
        return false;
    }

    limit.count++;
    return true;
}

// Nettoyer les rate limits toutes les minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimits.entries()) {
        if (now > value.resetTime) {
            rateLimits.delete(key);
        }
    }
}, 60000);

class GameRoom {
    constructor(id, creator, gameSettings = {}) {
        this.id = id;
        this.creator = creator;
        this.players = [];
        this.spectators = [];
        this.gameState = 'waiting'; // waiting, playing, finished
        this.targets = [];
        this.scores = {};
        this.gameStartTime = null;
        this.password = gameSettings.password || null; // Protection par mot de passe
        this.chatMessages = []; // Historique du chat
        this.playerStats = {}; // Statistiques des joueurs

        // NOUVELLES PROPRIÉTÉS pour les modes de jeu
        this.gameSettings = {
            targetCount: gameSettings.targetCount || 20,
            gameMode: gameSettings.gameMode || 'classic', // classic, progressive, blitz, sniper
            spawnMode: gameSettings.spawnMode || 'all-at-once', // all-at-once, one-by-one
            targetLifetime: gameSettings.targetLifetime || 0, // 0 = infini, sinon en secondes
            difficulty: gameSettings.difficulty || 'normal' // easy, normal, hard
        };

        this.gameData = {
            width: 800,
            height: 600
        };

        // Pour le mode progressif
        this.currentTargetIndex = 0;
        this.targetSpawnInterval = null;
        this.gameTimers = new Map(); // Map<timer_id, type> pour mieux nettoyer les timers
        this.blitzCheckInterval = null;
    }

    addPlayer(socketId, username, role) {
        if (role === 'player' && this.players.length < 2) {
            this.players.push({ socketId, username, role: 'player' });
            this.scores[socketId] = 0;
            // Initialiser les stats du joueur
            this.playerStats[socketId] = {
                hits: 0,
                misses: 0,
                accuracy: 0,
                bestStreak: 0,
                currentStreak: 0,
                totalPoints: 0
            };
            return true;
        } else if (role === 'spectator') {
            this.spectators.push({ socketId, username, role: 'spectator' });
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        this.players = this.players.filter(p => p.socketId !== socketId);
        this.spectators = this.spectators.filter(s => s.socketId !== socketId);
        delete this.scores[socketId];
        delete this.playerStats[socketId];

        // Nettoyer les timers si la room devient vide
        if (this.players.length === 0 && this.spectators.length === 0) {
            this.cleanup();
        }
    }

    cleanup() {
        logInfo(`Nettoyage de la room ${this.id}`);

        // Nettoyer tous les timers avec la nouvelle Map
        this.gameTimers.forEach((type, timerId) => {
            clearInterval(timerId);
            clearTimeout(timerId);
        });
        this.gameTimers.clear();

        if (this.targetSpawnInterval) {
            clearInterval(this.targetSpawnInterval);
            this.targetSpawnInterval = null;
        }

        if (this.blitzCheckInterval) {
            clearInterval(this.blitzCheckInterval);
            this.blitzCheckInterval = null;
        }
    }

    addChatMessage(username, message) {
        const chatMessage = {
            username,
            message: sanitizeInput(message),
            timestamp: Date.now()
        };
        this.chatMessages.push(chatMessage);
        // Garder seulement les 100 derniers messages
        if (this.chatMessages.length > 100) {
            this.chatMessages.shift();
        }
        return chatMessage;
    }

    updatePlayerStats(socketId, hit) {
        if (!this.playerStats[socketId]) return;

        if (hit) {
            this.playerStats[socketId].hits++;
            this.playerStats[socketId].currentStreak++;
            if (this.playerStats[socketId].currentStreak > this.playerStats[socketId].bestStreak) {
                this.playerStats[socketId].bestStreak = this.playerStats[socketId].currentStreak;
            }
        } else {
            this.playerStats[socketId].misses++;
            this.playerStats[socketId].currentStreak = 0;
        }

        const total = this.playerStats[socketId].hits + this.playerStats[socketId].misses;
        this.playerStats[socketId].accuracy = total > 0
            ? Math.round((this.playerStats[socketId].hits / total) * 100)
            : 0;
        this.playerStats[socketId].totalPoints = this.scores[socketId];
    }

    canStartGame() {
        return this.players.length === 2 && this.gameState === 'waiting';
    }

    // Nouvelle méthode pour générer les cibles selon le mode
    generateTargets() {
        this.targets = [];
        const count = this.gameSettings.targetCount;
        
        for (let i = 0; i < count; i++) {
            const target = this.createTarget(i);
            this.targets.push(target);
        }
        
        // Gérer l'affichage selon le mode
        if (this.gameSettings.spawnMode === 'one-by-one') {
            // Mode progressif : une seule cible active au début
            this.targets.forEach((target, index) => {
                target.active = index === 0;
            });
            this.currentTargetIndex = 0;
        } else {
            // Mode classique : toutes actives
            this.targets.forEach(target => target.active = true);
        }
    }
    
    createTarget(id) {
        let size, points;
        
        // Taille selon la difficulté
        switch(this.gameSettings.difficulty) {
            case 'easy':
                size = Math.random() * 40 + 30; // 30-70px
                break;
            case 'hard':
                size = Math.random() * 20 + 15; // 15-35px
                break;
            default: // normal
                size = Math.random() * 30 + 20; // 20-50px
        }
        
        // Points selon le mode de jeu
        switch(this.gameSettings.gameMode) {
            case 'sniper':
                points = Math.floor(50 / size); // Plus petit = plus de points
                break;
            case 'blitz':
                points = 2; // Points doubles pour la difficulté
                break;
            default:
                points = 1;
        }
        
        return {
            id,
            x: Math.random() * (this.gameData.width - size) + size/2,
            y: Math.random() * (this.gameData.height - size) + size/2,
            size,
            points,
            active: false, // Sera défini selon le mode
            color: this.getTargetColor(),
            createdAt: Date.now(),
            lifetime: this.gameSettings.targetLifetime * 1000 // Convertir en ms
        };
    }
    
    getTargetColor() {
        switch(this.gameSettings.gameMode) {
            case 'sniper':
                return `hsl(${Math.random() * 60 + 300}, 70%, 60%)`; // Violet/Rose
            case 'blitz':
                return `hsl(${Math.random() * 60}, 90%, 60%)`; // Rouge/Orange
            default:
                return `hsl(${Math.random() * 360}, 70%, 60%)`;
        }
    }
    
    // Activer la prochaine cible (mode progressif)
    activateNextTarget() {
        if (this.gameSettings.spawnMode === 'one-by-one') {
            this.currentTargetIndex++;
            if (this.currentTargetIndex < this.targets.length) {
                this.targets[this.currentTargetIndex].active = true;
                return this.targets[this.currentTargetIndex];
            }
        }
        return null;
    }
    
    // Gérer l'expiration des cibles (mode blitz)
    checkExpiredTargets() {
        if (this.gameSettings.targetLifetime > 0) {
            const now = Date.now();
            const expiredTargets = [];
            
            this.targets.forEach(target => {
                if (target.active && (now - target.createdAt) > target.lifetime) {
                    target.active = false;
                    expiredTargets.push(target.id);
                }
            });
            
            return expiredTargets;
        }
        return [];
    }

    hitTarget(targetId, playerId) {
        const target = this.targets.find(t => t.id === targetId && t.active);
        if (target) {
            target.active = false;
            this.scores[playerId] += target.points || 1;
            
            // Activer la prochaine cible si mode progressif
            const nextTarget = this.activateNextTarget();
            
            return { success: true, points: target.points || 1, nextTarget };
        }
        return { success: false };
    }

    getActiveTargetsCount() {
        return this.targets.filter(t => t.active).length;
    }

    getWinner() {
        if (this.getActiveTargetsCount() === 0) {
            const playerScores = this.players.map(p => ({
                socketId: p.socketId,
                username: p.username,
                score: this.scores[p.socketId] || 0
            }));
            return playerScores.reduce((a, b) => a.score > b.score ? a : b);
        }
        return null;
    }

    // Méthode pour démarrer les timers selon le mode (CORRIGÉE - Memory leak fixé)
    startGameTimers(io) {
        // Mode Blitz : faire expirer les cibles
        if (this.gameSettings.gameMode === 'blitz' && this.gameSettings.targetLifetime > 0) {
            // FIX: Stocker l'ID du setInterval correctement
            this.blitzCheckInterval = setInterval(() => {
                try {
                    if (this.gameState !== 'playing') {
                        this.cleanup();
                        return;
                    }

                    const expiredTargets = this.checkExpiredTargets();
                    if (expiredTargets.length > 0) {
                        io.to(this.id).emit('targets-expired', {
                            expiredTargets,
                            remainingTargets: this.getActiveTargetsCount()
                        });

                        // Vérifier si la partie est terminée
                        const winner = this.getWinner();
                        if (winner) {
                            this.gameState = 'finished';
                            io.to(this.id).emit('game-finished', {
                                winner,
                                finalScores: this.scores,
                                playerStats: this.playerStats
                            });
                            this.cleanup();
                        }
                    }
                } catch (error) {
                    logError('Erreur dans le timer Blitz', error);
                    this.cleanup();
                }
            }, 100); // Vérifier chaque 100ms pour plus de précision

            // Stocker dans la Map pour un nettoyage approprié
            this.gameTimers.set(this.blitzCheckInterval, 'blitz-check');
            logInfo(`Timer Blitz démarré pour la room ${this.id}`);
        }
    }
}

// Gestionnaire de connexions Socket.io
io.on('connection', (socket) => {
    logInfo(`Nouvelle connexion: ${socket.id}`);

    // Rejoindre le lobby principal
    socket.on('join-lobby', (data) => {
        try {
            const username = typeof data === 'string' ? data : data.username;
            const reconnectToken = typeof data === 'object' ? data.reconnectToken : null;

            const sanitizedUsername = sanitizeInput(username);

            if (!sanitizedUsername || sanitizedUsername.length < 2) {
                socket.emit('room-error', 'Nom d\'utilisateur invalide (minimum 2 caractères)');
                return;
            }

            // Vérifier la reconnexion
            if (reconnectToken && disconnectedPlayers.has(reconnectToken)) {
                const playerData = disconnectedPlayers.get(reconnectToken);
                const room = gameRooms.get(playerData.roomId);

                if (room) {
                    logInfo(`Reconnexion du joueur ${sanitizedUsername} à la room ${room.id}`);

                    // Mettre à jour le socketId
                    const playerIndex = room.players.findIndex(p => p.socketId === playerData.oldSocketId);
                    if (playerIndex !== -1) {
                        room.players[playerIndex].socketId = socket.id;
                        // Transférer les scores et stats
                        if (room.scores[playerData.oldSocketId] !== undefined) {
                            room.scores[socket.id] = room.scores[playerData.oldSocketId];
                            delete room.scores[playerData.oldSocketId];
                        }
                        if (room.playerStats[playerData.oldSocketId]) {
                            room.playerStats[socket.id] = room.playerStats[playerData.oldSocketId];
                            delete room.playerStats[playerData.oldSocketId];
                        }
                    }

                    socket.join(room.id);
                    players.set(socket.id, {
                        username: sanitizedUsername,
                        currentRoom: room.id,
                        reconnectToken
                    });

                    socket.emit('reconnected', {
                        roomId: room.id,
                        gameState: room.gameState,
                        scores: room.scores,
                        players: room.players,
                        spectators: room.spectators,
                        targets: room.targets,
                        gameSettings: room.gameSettings
                    });

                    socket.to(room.id).emit('player-reconnected', {
                        username: sanitizedUsername,
                        playerId: socket.id
                    });

                    disconnectedPlayers.delete(reconnectToken);
                    return;
                }
            }

            // Connexion normale
            const newReconnectToken = `${socket.id}-${Date.now()}`;
            players.set(socket.id, {
                username: sanitizedUsername,
                currentRoom: null,
                reconnectToken: newReconnectToken
            });

            socket.emit('lobby-joined', {
                reconnectToken: newReconnectToken,
                rooms: Array.from(gameRooms.values()).map(room => ({
                    id: room.id,
                    creator: room.creator,
                    playerCount: room.players.length,
                    spectatorCount: room.spectators.length,
                    gameState: room.gameState,
                    gameSettings: room.gameSettings,
                    hasPassword: !!room.password
                }))
            });

            logInfo(`${sanitizedUsername} a rejoint le lobby`);
        } catch (error) {
            logError('Erreur dans join-lobby', error);
            socket.emit('room-error', 'Erreur lors de la connexion au lobby');
        }
    });

    // Créer une nouvelle room AVEC paramètres (AMÉLIORÉE)
    socket.on('create-room-with-settings', (data) => {
        try {
            const { roomId, username, gameSettings, password } = data;

            const sanitizedRoomId = sanitizeInput(roomId);
            const sanitizedUsername = sanitizeInput(username);

            if (!sanitizedRoomId || sanitizedRoomId.length < 2) {
                socket.emit('room-error', 'Nom de room invalide (minimum 2 caractères)');
                return;
            }

            if (gameRooms.has(sanitizedRoomId)) {
                socket.emit('room-error', 'Cette room existe déjà');
                return;
            }

            // Ajouter le mot de passe si fourni
            const roomSettings = {
                ...gameSettings,
                password: password ? sanitizeInput(password) : null
            };

            const newRoom = new GameRoom(sanitizedRoomId, sanitizedUsername, roomSettings);
            gameRooms.set(sanitizedRoomId, newRoom);

            socket.join(sanitizedRoomId);
            // Note: Ne pas ajouter le joueur automatiquement, attendre le choix de rôle

            const player = players.get(socket.id);
            if (player) player.currentRoom = sanitizedRoomId;

            socket.emit('room-created-with-settings', {
                roomId: sanitizedRoomId,
                gameSettings: newRoom.gameSettings,
                hasPassword: !!newRoom.password
            });

            logInfo(`Room créée: ${sanitizedRoomId} par ${sanitizedUsername}`);
            updateRoomLobby();
        } catch (error) {
            logError('Erreur dans create-room-with-settings', error);
            socket.emit('room-error', 'Erreur lors de la création de la room');
        }
    });

    // Créer une room simple (rétro-compatibilité)
    socket.on('create-room', (data) => {
        const { roomId, username } = data;
        
        if (gameRooms.has(roomId)) {
            socket.emit('room-error', 'Cette room existe déjà');
            return;
        }

        const newRoom = new GameRoom(roomId, username);
        gameRooms.set(roomId, newRoom);
        
        socket.join(roomId);
        newRoom.addPlayer(socket.id, username, 'player');
        
        const player = players.get(socket.id);
        if (player) player.currentRoom = roomId;

        socket.emit('room-created', { roomId });
        updateRoomLobby();
    });

    // Choisir son rôle dans une room (AMÉLIORÉE)
    socket.on('choose-role-in-room', (data) => {
        try {
            const { roomId, username, role, password } = data;
            const room = gameRooms.get(roomId);

            if (!room) {
                socket.emit('room-error', 'Room introuvable');
                return;
            }

            // Vérifier le mot de passe si nécessaire
            if (room.password && room.password !== password) {
                socket.emit('room-error', 'Mot de passe incorrect');
                return;
            }

            const sanitizedUsername = sanitizeInput(username);

            if (!room.addPlayer(socket.id, sanitizedUsername, role)) {
                socket.emit('room-error', 'Impossible de prendre ce rôle (room pleine?)');
                return;
            }

            socket.emit('role-chosen', {
                roomId,
                role,
                gameSettings: room.gameSettings,
                gameData: room.gameData,
                players: room.players,
                spectators: room.spectators,
                gameState: room.gameState,
                targets: room.targets,
                scores: room.scores,
                chatMessages: room.chatMessages
            });

            // Notifier les autres dans la room
            socket.to(roomId).emit('player-joined', {
                username: sanitizedUsername,
                role,
                players: room.players,
                spectators: room.spectators
            });

            logInfo(`${sanitizedUsername} a choisi le rôle ${role} dans ${roomId}`);
            updateRoomLobby();
        } catch (error) {
            logError('Erreur dans choose-role-in-room', error);
            socket.emit('room-error', 'Erreur lors du choix du rôle');
        }
    });

    // Envoyer un message de chat (NOUVEAU)
    socket.on('send-chat-message', (data) => {
        try {
            // Rate limiting pour le chat
            if (!checkRateLimit(socket.id, 'chat', 10, 5000)) {
                socket.emit('room-error', 'Vous envoyez des messages trop rapidement');
                return;
            }

            const player = players.get(socket.id);
            if (!player || !player.currentRoom) return;

            const room = gameRooms.get(player.currentRoom);
            if (!room) return;

            const message = sanitizeInput(data.message);
            if (!message || message.length === 0) return;

            const chatMessage = room.addChatMessage(player.username, message);

            io.to(room.id).emit('chat-message', chatMessage);
            logInfo(`Chat dans ${room.id}: ${player.username}: ${message}`);
        } catch (error) {
            logError('Erreur dans send-chat-message', error);
        }
    });

    // Rejoindre une room (ancien système)
    socket.on('join-room', (data) => {
        const { roomId, username, role } = data;
        const room = gameRooms.get(roomId);
        
        if (!room) {
            socket.emit('room-error', 'Room introuvable');
            return;
        }

        if (!room.addPlayer(socket.id, username, role)) {
            socket.emit('room-error', 'Impossible de rejoindre cette room');
            return;
        }

        socket.join(roomId);
        const player = players.get(socket.id);
        if (player) player.currentRoom = roomId;

        socket.emit('room-joined', { 
            roomId, 
            role,
            gameData: room.gameData,
            gameSettings: room.gameSettings,
            players: room.players,
            spectators: room.spectators,
            gameState: room.gameState,
            targets: room.targets,
            scores: room.scores
        });

        socket.to(roomId).emit('player-joined', {
            username,
            role,
            players: room.players,
            spectators: room.spectators
        });

        updateRoomLobby();
    });

    // Démarrer la partie
    socket.on('start-game', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentRoom) return;

        const room = gameRooms.get(player.currentRoom);
        if (!room || !room.canStartGame()) return;

        room.gameState = 'playing';
        room.generateTargets();
        room.gameStartTime = Date.now();

        // Démarrer les timers selon le mode de jeu
        room.startGameTimers(io);

        io.to(room.id).emit('game-started', {
            targets: room.targets,
            scores: room.scores,
            gameData: room.gameData,
            gameSettings: room.gameSettings
        });

        updateRoomLobby();
    });

    // Mouvement de la souris (viseur) avec throttling (AMÉLIORÉ)
    socket.on('mouse-move', (data) => {
        try {
            // Rate limiting pour éviter la surcharge - 30 fois par seconde max
            if (!checkRateLimit(socket.id, 'mouse-move', 30, 1000)) {
                return; // Silencieusement ignorer les événements en trop
            }

            const player = players.get(socket.id);
            if (!player || !player.currentRoom) return;

            const room = gameRooms.get(player.currentRoom);
            if (!room || room.gameState !== 'playing') return;

            // Valider les coordonnées
            const x = Math.max(0, Math.min(data.x, room.gameData.width));
            const y = Math.max(0, Math.min(data.y, room.gameData.height));

            socket.to(room.id).emit('player-mouse-move', {
                playerId: socket.id,
                x,
                y
            });
        } catch (error) {
            logError('Erreur dans mouse-move', error);
        }
    });

    // Tir sur une cible (AMÉLIORÉ avec tolérance et stats)
    socket.on('shoot-target', (data) => {
        try {
            // Rate limiting pour éviter le spam - 20 tirs par seconde max
            if (!checkRateLimit(socket.id, 'shoot', 20, 1000)) {
                return;
            }

            const player = players.get(socket.id);
            if (!player || !player.currentRoom) return;

            const room = gameRooms.get(player.currentRoom);
            if (!room || room.gameState !== 'playing') return;

            const { targetId, x, y } = data;
            const target = room.targets.find(t => t.id === targetId && t.active);

            if (target) {
                // Vérifier si le clic est dans la zone de la cible (avec tolérance de 5px)
                const distance = Math.sqrt(
                    Math.pow(x - target.x, 2) + Math.pow(y - target.y, 2)
                );

                const hitTolerance = 5; // pixels de tolérance
                const effectiveRadius = (target.size / 2) + hitTolerance;

                if (distance <= effectiveRadius) {
                    const hitResult = room.hitTarget(targetId, socket.id);

                    if (hitResult.success) {
                        // Mettre à jour les stats du joueur
                        room.updatePlayerStats(socket.id, true);

                        io.to(room.id).emit('target-hit', {
                            targetId,
                            playerId: socket.id,
                            playerName: player.username,
                            points: hitResult.points,
                            scores: room.scores,
                            remainingTargets: room.getActiveTargetsCount(),
                            nextTarget: hitResult.nextTarget,
                            playerStats: room.playerStats[socket.id]
                        });

                        // Vérifier si la partie est terminée
                        const winner = room.getWinner();
                        if (winner) {
                            room.gameState = 'finished';
                            room.cleanup(); // Nettoyer les timers
                            io.to(room.id).emit('game-finished', {
                                winner,
                                finalScores: room.scores,
                                playerStats: room.playerStats
                            });
                            logInfo(`Partie terminée dans ${room.id}, gagnant: ${winner.username}`);
                            updateRoomLobby();
                        }
                    }
                } else {
                    // Tir manqué
                    room.updatePlayerStats(socket.id, false);
                }
            }
        } catch (error) {
            logError('Erreur dans shoot-target', error);
        }
    });

    // Redémarrer la partie
    socket.on('restart-game', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentRoom) return;

        const room = gameRooms.get(player.currentRoom);
        if (!room) return;

        room.cleanup(); // Nettoyer les anciens timers
        room.gameState = 'waiting';
        room.targets = [];
        room.currentTargetIndex = 0;
        room.players.forEach(p => room.scores[p.socketId] = 0);

        io.to(room.id).emit('game-restarted', {
            gameState: room.gameState,
            scores: room.scores
        });

        updateRoomLobby();
    });

    // Déconnexion (AMÉLIORÉE avec reconnexion)
    socket.on('disconnect', (reason) => {
        logInfo(`Déconnexion: ${socket.id}, raison: ${reason}`);

        const player = players.get(socket.id);

        if (player && player.currentRoom) {
            const room = gameRooms.get(player.currentRoom);

            if (room) {
                // Si la partie est en cours, permettre la reconnexion pendant 60 secondes
                if (room.gameState === 'playing') {
                    logInfo(`${player.username} s'est déconnecté pendant la partie, reconnexion possible`);

                    disconnectedPlayers.set(player.reconnectToken, {
                        username: player.username,
                        roomId: player.currentRoom,
                        oldSocketId: socket.id,
                        disconnectedAt: Date.now()
                    });

                    // Supprimer après 60 secondes
                    setTimeout(() => {
                        if (disconnectedPlayers.has(player.reconnectToken)) {
                            disconnectedPlayers.delete(player.reconnectToken);
                            logInfo(`Token de reconnexion expiré pour ${player.username}`);

                            // Retirer le joueur de la room
                            const currentRoom = gameRooms.get(player.currentRoom);
                            if (currentRoom) {
                                currentRoom.removePlayer(socket.id);

                                io.to(currentRoom.id).emit('player-left', {
                                    playerId: socket.id,
                                    players: currentRoom.players,
                                    spectators: currentRoom.spectators
                                });

                                if (currentRoom.players.length === 0 && currentRoom.spectators.length === 0) {
                                    gameRooms.delete(currentRoom.id);
                                    logInfo(`Room ${currentRoom.id} supprimée (vide)`);
                                }

                                updateRoomLobby();
                            }
                        }
                    }, 60000);

                    // Notifier la room
                    socket.to(room.id).emit('player-disconnected', {
                        playerId: socket.id,
                        username: player.username,
                        canReconnect: true
                    });
                } else {
                    // Partie non commencée, retirer directement
                    room.removePlayer(socket.id);

                    socket.to(room.id).emit('player-left', {
                        playerId: socket.id,
                        players: room.players,
                        spectators: room.spectators
                    });

                    // Supprimer la room si elle est vide
                    if (room.players.length === 0 && room.spectators.length === 0) {
                        gameRooms.delete(room.id);
                        logInfo(`Room ${room.id} supprimée (vide)`);
                    }

                    updateRoomLobby();
                }
            }
        }

        players.delete(socket.id);
    });

    function updateRoomLobby() {
        io.emit('rooms-updated', {
            rooms: Array.from(gameRooms.values()).map(room => ({
                id: room.id,
                creator: room.creator,
                playerCount: room.players.length,
                spectatorCount: room.spectators.length,
                gameState: room.gameState,
                gameSettings: room.gameSettings
            }))
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Serveur Target Rush démarré sur le port ${PORT}`);
    console.log(`🌐 Accédez au jeu sur http://localhost:${PORT}`);
    console.log(`✨ Nouvelles fonctionnalités: Modes de jeu, paramètres personnalisables !`);
});