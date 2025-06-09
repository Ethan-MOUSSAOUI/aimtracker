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
    }
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Structure des données du jeu
const gameRooms = new Map();
const players = new Map();

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
        this.gameTimers = new Set(); // Pour nettoyer les timers
    }

    addPlayer(socketId, username, role) {
        if (role === 'player' && this.players.length < 2) {
            this.players.push({ socketId, username, role: 'player' });
            this.scores[socketId] = 0;
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
        
        // Nettoyer les timers si la room devient vide
        if (this.players.length === 0 && this.spectators.length === 0) {
            this.cleanup();
        }
    }

    cleanup() {
        // Nettoyer tous les timers
        this.gameTimers.forEach(timer => clearTimeout(timer));
        this.gameTimers.clear();
        if (this.targetSpawnInterval) {
            clearInterval(this.targetSpawnInterval);
            this.targetSpawnInterval = null;
        }
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

    // Méthode pour démarrer les timers selon le mode
    startGameTimers(io) {
        // Mode Blitz : faire expirer les cibles
        if (this.gameSettings.gameMode === 'blitz' && this.gameSettings.targetLifetime > 0) {
            const blitzTimer = setInterval(() => {
                if (this.gameState !== 'playing') {
                    clearInterval(blitzTimer);
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
                            finalScores: this.scores
                        });
                        clearInterval(blitzTimer);
                    }
                }
            }, 100); // Vérifier chaque 100ms pour plus de précision
            
            this.gameTimers.add(blitzTimer);
        }
    }
}

// Gestionnaire de connexions Socket.io
io.on('connection', (socket) => {
    console.log(`Nouvelle connexion: ${socket.id}`);

    // Rejoindre le lobby principal
    socket.on('join-lobby', (username) => {
        players.set(socket.id, { username, currentRoom: null });
        socket.emit('lobby-joined', { 
            rooms: Array.from(gameRooms.values()).map(room => ({
                id: room.id,
                creator: room.creator,
                playerCount: room.players.length,
                spectatorCount: room.spectators.length,
                gameState: room.gameState,
                gameSettings: room.gameSettings
            }))
        });
    });

    // Créer une nouvelle room AVEC paramètres
    socket.on('create-room-with-settings', (data) => {
        const { roomId, username, gameSettings } = data;
        
        if (gameRooms.has(roomId)) {
            socket.emit('room-error', 'Cette room existe déjà');
            return;
        }

        const newRoom = new GameRoom(roomId, username, gameSettings);
        gameRooms.set(roomId, newRoom);
        
        socket.join(roomId);
        // Note: Ne pas ajouter le joueur automatiquement, attendre le choix de rôle
        
        const player = players.get(socket.id);
        if (player) player.currentRoom = roomId;

        socket.emit('room-created-with-settings', { 
            roomId, 
            gameSettings: newRoom.gameSettings 
        });
        updateRoomLobby();
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

    // Choisir son rôle dans une room
    socket.on('choose-role-in-room', (data) => {
        const { roomId, username, role } = data;
        const room = gameRooms.get(roomId);
        
        if (!room) {
            socket.emit('room-error', 'Room introuvable');
            return;
        }

        if (!room.addPlayer(socket.id, username, role)) {
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
            scores: room.scores
        });

        // Notifier les autres dans la room
        socket.to(roomId).emit('player-joined', {
            username,
            role,
            players: room.players,
            spectators: room.spectators
        });

        updateRoomLobby();
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

    // Mouvement de la souris (viseur)
    socket.on('mouse-move', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.currentRoom) return;

        const room = gameRooms.get(player.currentRoom);
        if (!room || room.gameState !== 'playing') return;

        socket.to(room.id).emit('player-mouse-move', {
            playerId: socket.id,
            x: data.x,
            y: data.y
        });
    });

    // Tir sur une cible
    socket.on('shoot-target', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.currentRoom) return;

        const room = gameRooms.get(player.currentRoom);
        if (!room || room.gameState !== 'playing') return;

        const { targetId, x, y } = data;
        const target = room.targets.find(t => t.id === targetId && t.active);
        
        if (target) {
            // Vérifier si le clic est dans la zone de la cible
            const distance = Math.sqrt(
                Math.pow(x - target.x, 2) + Math.pow(y - target.y, 2)
            );
            
            if (distance <= target.size / 2) {
                const hitResult = room.hitTarget(targetId, socket.id);
                
                if (hitResult.success) {
                    io.to(room.id).emit('target-hit', {
                        targetId,
                        playerId: socket.id,
                        playerName: player.username,
                        points: hitResult.points,
                        scores: room.scores,
                        remainingTargets: room.getActiveTargetsCount(),
                        nextTarget: hitResult.nextTarget
                    });

                    // Vérifier si la partie est terminée
                    const winner = room.getWinner();
                    if (winner) {
                        room.gameState = 'finished';
                        room.cleanup(); // Nettoyer les timers
                        io.to(room.id).emit('game-finished', {
                            winner,
                            finalScores: room.scores
                        });
                        updateRoomLobby();
                    }
                }
            }
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

    // Déconnexion
    socket.on('disconnect', () => {
        console.log(`Déconnexion: ${socket.id}`);
        
        const player = players.get(socket.id);
        if (player && player.currentRoom) {
            const room = gameRooms.get(player.currentRoom);
            if (room) {
                room.removePlayer(socket.id);
                
                socket.to(room.id).emit('player-left', {
                    playerId: socket.id,
                    players: room.players,
                    spectators: room.spectators
                });

                // Supprimer la room si elle est vide
                if (room.players.length === 0 && room.spectators.length === 0) {
                    gameRooms.delete(room.id);
                }
                
                updateRoomLobby();
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