/**
 * No-PingPong Multiplayer Client
 * Handles WebSocket connection, matchmaking, and P2P game sync
 */

const Multiplayer = (() => {
    // WebSocket connection
    let ws = null;
    let serverUrl = null;

    // Match state
    let currentMatchId = null;
    let isPlayer1 = false;
    let opponentAddress = null;
    let opponentReady = false;

    // Game sync state
    let lastPaddleY = 0;
    let pendingBallState = null;

    // Callbacks
    let onMatchFound = null;
    let onGameStart = null;
    let onBallUpdate = null;
    let onOpponentPaddle = null;
    let onScoreUpdate = null;
    let onGameEnd = null;
    let onError = null;
    let onLobbyUpdate = null;
    let onConnectionChange = null;

    /**
     * Initialize multiplayer connection
     * @param {string} url - WebSocket server URL
     */
    function connect(url) {
        serverUrl = url || getDefaultServerUrl();

        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('[MP] Already connected');
            return;
        }

        ws = new WebSocket(serverUrl);

        ws.onopen = () => {
            console.log('[MP] Connected to server');
            if (onConnectionChange) onConnectionChange(true);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleMessage(msg);
            } catch (e) {
                console.error('[MP] Failed to parse message:', e);
            }
        };

        ws.onerror = (error) => {
            console.error('[MP] WebSocket error:', error);
            if (onError) onError('Connection error');
        };

        ws.onclose = () => {
            console.log('[MP] Disconnected from server');
            if (onConnectionChange) onConnectionChange(false);
            currentMatchId = null;
            opponentAddress = null;
        };
    }

    /**
     * Get default server URL based on current page
     */
    function getDefaultServerUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host; // includes port if present
        return `${protocol}//${host}`;
    }

    /**
     * Handle incoming WebSocket messages
     */
    function handleMessage(msg) {
        switch (msg.type) {
            case 'lobby_update':
                if (onLobbyUpdate) onLobbyUpdate(msg.matches);
                break;

            case 'match_created':
                currentMatchId = msg.matchId;
                isPlayer1 = true;
                console.log('[MP] Match created:', currentMatchId);
                break;

            case 'match_found':
                currentMatchId = msg.matchId;
                opponentAddress = msg.opponent;
                isPlayer1 = msg.isPlayer1;
                console.log('[MP] Match found:', currentMatchId, 'vs', opponentAddress);
                if (onMatchFound) onMatchFound(msg);
                break;

            case 'game_start':
                console.log('[MP] Game starting');
                if (onGameStart) onGameStart(msg);
                break;

            case 'ball_state':
                // Server authoritative ball position
                pendingBallState = {
                    x: msg.x,
                    y: msg.y,
                    vx: msg.vx,
                    vy: msg.vy
                };
                if (onBallUpdate) onBallUpdate(pendingBallState);
                break;

            case 'opponent_paddle':
                if (onOpponentPaddle) onOpponentPaddle(msg.y);
                break;

            case 'score_update':
                if (onScoreUpdate) onScoreUpdate(msg.player1Score, msg.player2Score);
                break;

            case 'game_end':
                console.log('[MP] Game ended, winner:', msg.winner);
                if (onGameEnd) onGameEnd(msg.winner, msg.matchId);
                currentMatchId = null;
                opponentAddress = null;
                break;

            case 'match_cancelled':
                console.log('[MP] Match cancelled');
                if (onError) onError('Match cancelled: ' + (msg.reason || 'opponent left'));
                currentMatchId = null;
                opponentAddress = null;
                break;

            case 'error':
                console.error('[MP] Server error:', msg.message);
                if (onError) onError(msg.message);
                break;

            default:
                console.log('[MP] Unknown message type:', msg.type);
        }
    }

    /**
     * Send message to server
     */
    function send(msg) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[MP] Not connected');
            return false;
        }
        ws.send(JSON.stringify(msg));
        return true;
    }

    /**
     * Register player with server
     * @param {string} address - Player's wallet address
     * @param {number} nftId - Player's selected NFT ID
     */
    function register(address, nftId) {
        return send({
            type: 'register',
            address: address,
            nftId: nftId
        });
    }

    /**
     * Request to create a new wager match
     * @param {string} stake - Stake tier (micro, low, medium, high)
     * @param {string} txHash - Transaction hash from createMatch()
     * @param {number} matchId - On-chain match ID
     */
    function createMatch(stake, txHash, matchId) {
        return send({
            type: 'create_match',
            stake: stake,
            txHash: txHash,
            onchainMatchId: matchId
        });
    }

    /**
     * Request to join an existing match
     * @param {string} matchId - Server match ID to join
     * @param {string} txHash - Transaction hash from joinMatch()
     */
    function joinMatch(matchId, txHash) {
        return send({
            type: 'join_match',
            matchId: matchId,
            txHash: txHash
        });
    }

    /**
     * Signal ready to start game
     */
    function ready() {
        return send({
            type: 'ready',
            matchId: currentMatchId
        });
    }

    /**
     * Send paddle position update
     * @param {number} y - Paddle Y position
     */
    function sendPaddle(y) {
        // Throttle paddle updates (only send if changed significantly)
        if (Math.abs(y - lastPaddleY) < 2) return;
        lastPaddleY = y;

        return send({
            type: 'paddle',
            matchId: currentMatchId,
            y: y
        });
    }

    /**
     * Request lobby/open matches list
     */
    function requestLobby() {
        return send({
            type: 'get_lobby'
        });
    }

    /**
     * Cancel waiting match
     */
    function cancelMatch() {
        if (!currentMatchId) return false;
        return send({
            type: 'cancel_match',
            matchId: currentMatchId
        });
    }

    /**
     * Disconnect from server
     */
    function disconnect() {
        if (ws) {
            ws.close();
            ws = null;
        }
        currentMatchId = null;
        opponentAddress = null;
    }

    /**
     * Check if connected to server
     */
    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    /**
     * Check if in active match
     */
    function inMatch() {
        return currentMatchId !== null;
    }

    /**
     * Get current match info
     */
    function getMatchInfo() {
        return {
            matchId: currentMatchId,
            isPlayer1: isPlayer1,
            opponent: opponentAddress
        };
    }

    /**
     * Get pending ball state (for interpolation)
     */
    function getPendingBallState() {
        const state = pendingBallState;
        pendingBallState = null;
        return state;
    }

    // Event registration
    function on(event, callback) {
        switch (event) {
            case 'matchFound': onMatchFound = callback; break;
            case 'gameStart': onGameStart = callback; break;
            case 'ballUpdate': onBallUpdate = callback; break;
            case 'opponentPaddle': onOpponentPaddle = callback; break;
            case 'scoreUpdate': onScoreUpdate = callback; break;
            case 'gameEnd': onGameEnd = callback; break;
            case 'error': onError = callback; break;
            case 'lobbyUpdate': onLobbyUpdate = callback; break;
            case 'connectionChange': onConnectionChange = callback; break;
        }
    }

    // Public API
    return {
        connect,
        disconnect,
        register,
        createMatch,
        joinMatch,
        ready,
        sendPaddle,
        requestLobby,
        cancelMatch,
        isConnected,
        inMatch,
        getMatchInfo,
        getPendingBallState,
        on
    };
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Multiplayer;
}
