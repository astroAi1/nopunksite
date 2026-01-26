/**
 * No-PingPong Wager UI
 * Handles stake selection, lobby display, and match state UI
 */

const WagerUI = (() => {
    // Contract addresses (update after deployment)
    const CONTRACT_ADDRESS = {
        baseSepolia: '0x0000000000000000000000000000000000000000', // TODO: Deploy and update
        baseMainnet: '0x0000000000000000000000000000000000000000'  // TODO: Deploy and update
    };

    // Stake tiers in ETH
    const STAKE_TIERS = {
        micro: { eth: '0.0002', display: '$0.50', wei: '200000000000000' },
        low: { eth: '0.0004', display: '$1.00', wei: '400000000000000' },
        medium: { eth: '0.001', display: '$2.50', wei: '1000000000000000' },
        high: { eth: '0.002', display: '$5.00', wei: '2000000000000000' }
    };

    // Contract ABI (minimal for wagering)
    const WAGER_ABI = [
        'function createMatch() payable returns (uint256)',
        'function joinMatch(uint256 matchId) payable',
        'function claimWinnings(uint256 matchId)',
        'function cancelMatch(uint256 matchId)',
        'function getMatch(uint256 matchId) view returns (tuple(address player1, address player2, uint256 stake, uint256 createdAt, uint256 startedAt, address winner, uint8 status, bool player1Claimed, bool player2Claimed))',
        'function getOpenMatches() view returns (uint256[])',
        'function canClaim(uint256 matchId, address claimer) view returns (bool)',
        'event MatchCreated(uint256 indexed matchId, address indexed player1, uint256 stake)',
        'event MatchJoined(uint256 indexed matchId, address indexed player2)',
        'event MatchCompleted(uint256 indexed matchId, address indexed winner, uint256 payout)'
    ];

    // State
    let currentScreen = 'menu'; // menu, stake, lobby, ingame, result
    let selectedStake = null;
    let pendingMatchId = null;
    let contract = null;
    let signer = null;

    // DOM Elements (cached)
    let elements = {};

    /**
     * Initialize wager UI
     */
    function init() {
        createUIElements();
        bindEvents();
        showScreen('menu');
    }

    /**
     * Create all UI elements
     */
    function createUIElements() {
        // Main wager container
        const container = document.createElement('div');
        container.id = 'wager-container';
        container.innerHTML = `
            <!-- Mode Selection Menu -->
            <div id="wager-menu" class="wager-screen">
                <h2>SELECT MODE</h2>
                <button id="btn-practice" class="wager-btn large">PRACTICE</button>
                <button id="btn-wager" class="wager-btn large primary">WAGER MATCH</button>
            </div>

            <!-- Stake Selection -->
            <div id="wager-stake" class="wager-screen hidden">
                <h2>SELECT STAKE</h2>
                <div class="stake-grid">
                    <button class="stake-btn" data-tier="micro">
                        <span class="stake-amount">$0.50</span>
                        <span class="stake-eth">0.0002 ETH</span>
                    </button>
                    <button class="stake-btn" data-tier="low">
                        <span class="stake-amount">$1.00</span>
                        <span class="stake-eth">0.0004 ETH</span>
                    </button>
                    <button class="stake-btn" data-tier="medium">
                        <span class="stake-amount">$2.50</span>
                        <span class="stake-eth">0.001 ETH</span>
                    </button>
                    <button class="stake-btn" data-tier="high">
                        <span class="stake-amount">$5.00</span>
                        <span class="stake-eth">0.002 ETH</span>
                    </button>
                </div>
                <button id="btn-find-match" class="wager-btn primary" disabled>FIND OPPONENT</button>
                <button id="btn-back-menu" class="wager-btn">BACK</button>
            </div>

            <!-- Lobby / Waiting -->
            <div id="wager-lobby" class="wager-screen hidden">
                <h2>FINDING OPPONENT...</h2>
                <div class="lobby-status">
                    <div class="spinner"></div>
                    <p id="lobby-message">Creating match on-chain...</p>
                </div>
                <div id="lobby-matches" class="lobby-matches hidden">
                    <h3>OPEN MATCHES</h3>
                    <div id="match-list"></div>
                </div>
                <button id="btn-cancel-match" class="wager-btn">CANCEL</button>
            </div>

            <!-- In-Game Overlay -->
            <div id="wager-ingame" class="wager-overlay hidden">
                <div class="pot-display">
                    <span>POT:</span>
                    <span id="pot-amount">$0.00</span>
                </div>
            </div>

            <!-- Result Screen -->
            <div id="wager-result" class="wager-screen hidden">
                <h2 id="result-title">MATCH COMPLETE</h2>
                <div id="result-message"></div>
                <div id="result-payout" class="hidden">
                    <span>WINNINGS:</span>
                    <span id="payout-amount"></span>
                </div>
                <button id="btn-claim" class="wager-btn primary hidden">CLAIM WINNINGS</button>
                <button id="btn-play-again" class="wager-btn">PLAY AGAIN</button>
            </div>
        `;

        // Insert into game area (over canvas)
        const gameSection = document.querySelector('.game-area') || document.querySelector('.bottom-left') || document.body;
        gameSection.appendChild(container);

        // Cache element references
        elements = {
            container: container,
            menu: document.getElementById('wager-menu'),
            stake: document.getElementById('wager-stake'),
            lobby: document.getElementById('wager-lobby'),
            ingame: document.getElementById('wager-ingame'),
            result: document.getElementById('wager-result'),
            btnPractice: document.getElementById('btn-practice'),
            btnWager: document.getElementById('btn-wager'),
            btnFindMatch: document.getElementById('btn-find-match'),
            btnBackMenu: document.getElementById('btn-back-menu'),
            btnCancelMatch: document.getElementById('btn-cancel-match'),
            btnClaim: document.getElementById('btn-claim'),
            btnPlayAgain: document.getElementById('btn-play-again'),
            lobbyMessage: document.getElementById('lobby-message'),
            lobbyMatches: document.getElementById('lobby-matches'),
            matchList: document.getElementById('match-list'),
            potAmount: document.getElementById('pot-amount'),
            resultTitle: document.getElementById('result-title'),
            resultMessage: document.getElementById('result-message'),
            resultPayout: document.getElementById('result-payout'),
            payoutAmount: document.getElementById('payout-amount'),
            stakeBtns: document.querySelectorAll('.stake-btn')
        };
    }

    /**
     * Bind UI events
     */
    function bindEvents() {
        // Menu buttons
        elements.btnPractice.addEventListener('click', () => {
            hideWagerUI();
            if (window.startPracticeMode) window.startPracticeMode();
        });

        elements.btnWager.addEventListener('click', () => {
            if (!window.currentWallet) {
                alert('Please connect your wallet first');
                return;
            }
            showScreen('stake');
        });

        // Stake selection
        elements.stakeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                elements.stakeBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedStake = btn.dataset.tier;
                elements.btnFindMatch.disabled = false;
            });
        });

        elements.btnFindMatch.addEventListener('click', findOpponent);
        elements.btnBackMenu.addEventListener('click', () => showScreen('menu'));
        elements.btnCancelMatch.addEventListener('click', cancelMatch);
        elements.btnClaim.addEventListener('click', claimWinnings);
        elements.btnPlayAgain.addEventListener('click', () => showScreen('menu'));
    }

    /**
     * Show a specific screen
     */
    function showScreen(screen) {
        currentScreen = screen;

        // Hide all screens
        elements.menu.classList.add('hidden');
        elements.stake.classList.add('hidden');
        elements.lobby.classList.add('hidden');
        elements.ingame.classList.add('hidden');
        elements.result.classList.add('hidden');

        // Show container
        elements.container.classList.remove('hidden');

        // Show requested screen
        switch (screen) {
            case 'menu':
                elements.menu.classList.remove('hidden');
                break;
            case 'stake':
                elements.stake.classList.remove('hidden');
                selectedStake = null;
                elements.btnFindMatch.disabled = true;
                elements.stakeBtns.forEach(b => b.classList.remove('selected'));
                break;
            case 'lobby':
                elements.lobby.classList.remove('hidden');
                break;
            case 'ingame':
                elements.ingame.classList.remove('hidden');
                break;
            case 'result':
                elements.result.classList.remove('hidden');
                break;
        }
    }

    /**
     * Hide entire wager UI (for practice mode)
     */
    function hideWagerUI() {
        elements.container.classList.add('hidden');
    }

    /**
     * Show wager UI
     */
    function showWagerUI() {
        elements.container.classList.remove('hidden');
    }

    /**
     * Initialize contract connection
     */
    async function initContract() {
        if (!window.ethereum) {
            throw new Error('No wallet detected');
        }

        const provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();

        const network = await provider.getNetwork();
        const chainId = network.chainId;

        let contractAddress;
        if (chainId === 8453) {
            contractAddress = CONTRACT_ADDRESS.baseMainnet;
        } else if (chainId === 84532) {
            contractAddress = CONTRACT_ADDRESS.baseSepolia;
        } else {
            throw new Error('Please connect to Base network');
        }

        if (contractAddress === '0x0000000000000000000000000000000000000000') {
            throw new Error('Contract not yet deployed');
        }

        contract = new ethers.Contract(contractAddress, WAGER_ABI, signer);
        return contract;
    }

    /**
     * Find opponent - create match on-chain and wait
     */
    async function findOpponent() {
        if (!selectedStake) return;

        try {
            showScreen('lobby');
            elements.lobbyMessage.textContent = 'Creating match on-chain...';

            // Initialize contract if needed
            if (!contract) {
                await initContract();
            }

            // Get stake amount in wei
            const stakeWei = STAKE_TIERS[selectedStake].wei;

            // Create match on-chain
            elements.lobbyMessage.textContent = 'Confirm transaction in wallet...';
            const tx = await contract.createMatch({ value: stakeWei });

            elements.lobbyMessage.textContent = 'Waiting for confirmation...';
            const receipt = await tx.wait();

            // Get match ID from event
            const event = receipt.events?.find(e => e.event === 'MatchCreated');
            if (event) {
                pendingMatchId = event.args.matchId.toNumber();
            }

            elements.lobbyMessage.textContent = 'Match created! Waiting for opponent...';

            // Connect to multiplayer server
            Multiplayer.connect();
            Multiplayer.on('connectionChange', (connected) => {
                if (connected) {
                    Multiplayer.register(window.currentWallet, window.leftNftId || 0);
                    Multiplayer.createMatch(selectedStake, tx.hash, pendingMatchId);
                }
            });

            Multiplayer.on('matchFound', onMatchFound);
            Multiplayer.on('gameStart', onGameStart);
            Multiplayer.on('gameEnd', onGameEnd);
            Multiplayer.on('error', onMultiplayerError);

        } catch (error) {
            console.error('Failed to create match:', error);
            elements.lobbyMessage.textContent = 'Error: ' + (error.reason || error.message);
            setTimeout(() => showScreen('stake'), 3000);
        }
    }

    /**
     * Cancel waiting match
     */
    async function cancelMatch() {
        try {
            elements.lobbyMessage.textContent = 'Cancelling match...';

            // Cancel on server
            Multiplayer.cancelMatch();

            // Note: On-chain cancellation requires 5 min timeout
            // User will need to call cancelMatch() on contract after timeout

            showScreen('menu');
        } catch (error) {
            console.error('Failed to cancel:', error);
        }
    }

    /**
     * Claim winnings from completed match
     */
    async function claimWinnings() {
        if (!pendingMatchId || !contract) return;

        try {
            elements.btnClaim.disabled = true;
            elements.btnClaim.textContent = 'CLAIMING...';

            const tx = await contract.claimWinnings(pendingMatchId);
            await tx.wait();

            elements.btnClaim.textContent = 'CLAIMED!';
            elements.btnClaim.classList.add('claimed');

        } catch (error) {
            console.error('Failed to claim:', error);
            elements.btnClaim.disabled = false;
            elements.btnClaim.textContent = 'CLAIM WINNINGS';
            alert('Failed to claim: ' + (error.reason || error.message));
        }
    }

    /**
     * Handle match found event
     */
    function onMatchFound(data) {
        elements.lobbyMessage.textContent = `Opponent found: ${formatAddress(data.opponent)}`;

        // Update pot display
        const stake = STAKE_TIERS[selectedStake];
        const potValue = parseFloat(stake.display.replace('$', '')) * 2;
        elements.potAmount.textContent = '$' + potValue.toFixed(2);

        // Short delay then start
        setTimeout(() => {
            Multiplayer.ready();
        }, 1000);
    }

    /**
     * Handle game start event
     */
    function onGameStart(data) {
        showScreen('ingame');

        // Start multiplayer game mode
        if (window.startMultiplayerGame) {
            window.startMultiplayerGame(data);
        }
    }

    /**
     * Handle game end event
     */
    function onGameEnd(winner, matchId) {
        const isWinner = winner.toLowerCase() === window.currentWallet?.toLowerCase();

        elements.resultTitle.textContent = isWinner ? 'YOU WIN!' : 'YOU LOSE';
        elements.resultTitle.className = isWinner ? 'win' : 'lose';

        if (isWinner) {
            const stake = STAKE_TIERS[selectedStake];
            const payout = parseFloat(stake.display.replace('$', '')) * 2;
            elements.payoutAmount.textContent = '$' + payout.toFixed(2);
            elements.resultPayout.classList.remove('hidden');
            elements.btnClaim.classList.remove('hidden');
            elements.btnClaim.disabled = false;
            elements.btnClaim.textContent = 'CLAIM WINNINGS';
        } else {
            elements.resultPayout.classList.add('hidden');
            elements.btnClaim.classList.add('hidden');
        }

        showScreen('result');
    }

    /**
     * Handle multiplayer errors
     */
    function onMultiplayerError(message) {
        elements.lobbyMessage.textContent = 'Error: ' + message;
        setTimeout(() => showScreen('menu'), 3000);
    }

    /**
     * Update in-game display
     */
    function updateIngameDisplay(myScore, oppScore) {
        // Could add score display to overlay if needed
    }

    /**
     * Format wallet address for display
     */
    function formatAddress(addr) {
        if (!addr) return '???';
        return addr.slice(0, 6) + '...' + addr.slice(-4);
    }

    /**
     * Join an existing match from lobby
     */
    async function joinExistingMatch(matchId, stake) {
        try {
            showScreen('lobby');
            elements.lobbyMessage.textContent = 'Joining match...';

            if (!contract) {
                await initContract();
            }

            selectedStake = stake;
            const stakeWei = STAKE_TIERS[stake].wei;

            elements.lobbyMessage.textContent = 'Confirm transaction in wallet...';
            const tx = await contract.joinMatch(matchId, { value: stakeWei });

            elements.lobbyMessage.textContent = 'Waiting for confirmation...';
            await tx.wait();

            pendingMatchId = matchId;
            elements.lobbyMessage.textContent = 'Joined! Starting game...';

            // Connect to server and join
            Multiplayer.connect();
            Multiplayer.on('connectionChange', (connected) => {
                if (connected) {
                    Multiplayer.register(window.currentWallet, window.leftNftId || 0);
                    Multiplayer.joinMatch(matchId.toString(), tx.hash);
                }
            });

            Multiplayer.on('matchFound', onMatchFound);
            Multiplayer.on('gameStart', onGameStart);
            Multiplayer.on('gameEnd', onGameEnd);
            Multiplayer.on('error', onMultiplayerError);

        } catch (error) {
            console.error('Failed to join match:', error);
            elements.lobbyMessage.textContent = 'Error: ' + (error.reason || error.message);
            setTimeout(() => showScreen('menu'), 3000);
        }
    }

    // Public API
    return {
        init,
        showScreen,
        hideWagerUI,
        showWagerUI,
        updateIngameDisplay,
        joinExistingMatch,
        STAKE_TIERS
    };
})();

// Auto-init when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', WagerUI.init);
} else {
    WagerUI.init();
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WagerUI;
}
