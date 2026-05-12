# InsectPump

High-performance Solana trading bot untuk Pump.fun dengan 4-stage filtering system. Hybrid architecture menggunakan free WSS + Alchemy + Helius API.

## Fitur Utama

- **4-Stage Filtering System:**
  - **L1:** Market Cap filter (25-300 SOL)
  - **L2:** Alchemy TX filter (min 50 total TX, skip burn/dev wallets)
  - **L3:** Helius whale analyzer (winrate & trading activity)
  - **L4:** Final score calculation (buys/sells ratio, profit factor)

- **Dual Token Strategy:**
  - **New Token Detection:** Deteksi whale buys di token baru via Eye WSS
  - **Pumping Token Detection:** Deteksi token yang lagi mooning (>10% growth)

- **Advanced Features:**
  - Copy-sell dari dewa (hanya saat cutloss)
  - Trailing stop (aktif setelah 30% profit)
  - Anti-sniper protection (skip 30 detik pertama)
  - Bundle detection & protection
  - Priority fee management (dynamic)
  - Telegram notifications

- **DEX Execution Routes:**
  - Pump.fun bonding curve via PumpPortal
  - Pump AMM / PumpSwap via PumpPortal
  - Raydium native AMM V4 / CPMM via Raydium SDK
  - Meteora native DLMM via Meteora SDK
  - Raydium PumpPortal fallback kalau native route gagal

## Prerequisites

Sebelum install, pastikan punya:

1. **Node.js** v18+ (direkomendasikan v20 LTS)
2. **npm** atau **yarn**
3. **Git**
4. **API Keys:**
   - Helius API key (premium untuk L3/L4 + execution)
   - Alchemy API key (free tier untuk L2 filtering)
5. **Wallet:**
   - Solana wallet dengan private key (base58 format)
   - Min 0.5 SOL untuk trading + gas
6. **Telegram** (opsional):
   - Bot token dari @BotFather
   - Chat ID untuk notifikasi

## Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/0xmultiserver-crypto/InsectPump.git
cd InsectPump
```

### Step 2: Install Node.js Dependencies

```bash
npm install
```

Ini akan install semua dependencies:

**Core Dependencies:**
- `@coral-xyz/anchor` ^0.29.0 - Solana program framework
- `@meteora-ag/dlmm` - Meteora DLMM native swap SDK
- `@raydium-io/raydium-sdk-v2` - Raydium AMM/CPMM native swap SDK
- `@solana/spl-token` ^0.3.9 - Token operations
- `@solana/web3.js` ^1.87.6 - Solana RPC client
- `axios` ^1.6.2 - HTTP client untuk API calls
- `better-sqlite3` ^9.4.3 - Database local (SQLite)
- `bn.js` - Big number math untuk native DEX SDK
- `bs58` ^5.0.0 - Base58 encoding untuk private key
- `dotenv` ^16.3.1 - Environment variables
- `p-limit` ^5.0.0 - Concurrency limiter
- `telegraf` ^4.15.3 - Telegram bot framework
- `winston` ^3.11.0 - Logging library
- `ws` ^8.14.2 - WebSocket client untuk real-time data

**Dev Dependencies:**
- `typescript` ^5.3.3 - TypeScript compiler
- `ts-node` ^10.9.2 - Run TypeScript directly
- `nodemon` ^3.0.2 - Auto-restart saat development
- `eslint` ^8.55.0 - Linting
- `@types/*` - Type definitions

### Step 3: Build Project

```bash
npm run build
```

Ini akan compile TypeScript ke folder `dist/`.

### Step 4: Setup Environment Variables

Copy file `.env.example` ke `.env`:

```bash
cp .env.example .env
```

Edit `.env` dan isi dengan API keys dan private key:

```env
# ==================== RPC & API (Secrets) ====================
# Helius - PREMIUM (L3/L4 analysis + execution)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key_here
HELIUS_API_KEY=your_helius_api_key_here

# Alchemy - FREE TIER (L2 filtering only)
ALCHEMY_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/your_key_here
ALCHEMY_API_KEY=your_alchemy_api_key_here

# PumpPortal - FREE WSS (real-time monitoring)
PUMP_PORTAL_WSS=wss://pumpportal.fun/api/data

# ==================== WALLET (Secret) ====================
# Private key base58 format
PRIVATE_KEY=your_base58_private_key_here

# ==================== TELEGRAM (Optional) ====================
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

**Cara dapetin API Keys:**

1. **Helius:**
   - Daftar di https://helius.dev/
   - Pilih plan (Developer $49/bulan atau free trial)
   - Copy API key dari dashboard

2. **Alchemy:**
   - Daftar di https://alchemy.com/
   - Create app untuk Solana Mainnet
   - Pilih free tier (10M credits/bulan)
   - Copy API key

3. **Telegram Bot:**
   - Chat @BotFather di Telegram
   - Kirim `/newbot`, ikuti instruksi
   - Copy bot token
   - Chat bot lu, kirim `/start`
   - Cek chat ID via https://api.telegram.org/bot<TOKEN>/getUpdates

### Step 5: Konfigurasi Strategi Trading

Semua parameter strategi ada di `src/config/config.ts`:

**Key Settings:**

```typescript
// Ukuran buy per trade
OUR_BUY_SIZE_SOL: 0.1,           // Buy 0.1 SOL per posisi

// Mcap entry
OUR_MIN_MCAP_SOL: 60,            // Entry min 60 SOL mcap
OUR_MAX_MCAP_SOL: 300,           // Entry max 300 SOL mcap

// Whale detection (inang)
MIN_INANG_BUY_SOL: 0.3,          // Whale buy min 0.3 SOL
MAX_INANG_BUY_SOL: 2.0,          // Whale buy max 2.0 SOL

// Anti-sniper
SNIPER_WINDOW_SECONDS: 30,        // Skip 30 detik pertama

// Helius L3 filter (STRICT mode)
MIN_TRADING_ACTIVITY: 10,        // Min 10 swaps
MIN_WINRATE_PERCENT: 40,         // Min 40% winrate
MIN_COMPLETED_TRADES: 3,         // Min 3 round-trip trades

// Trailing stop
TRAILING_ACTIVATION_PERCENT: 30,  // 30% profit = trailing aktif
TRAILING_STOP_DROP: 20,          // 20% drop dari highest = sell
EMERGENCY_STOP_LOSS: 50,         // -50% dari entry = emergency sell

// Position management
MAX_CONCURRENT_POSITIONS: 2,     // Max 2 posisi open
```

Edit file `src/config/config.ts` sesuai strategi lu, lalu rebuild:

```bash
npm run build
```

### Step 6: Setup Database & Data Directory

```bash
mkdir -p data
```

Database SQLite akan otomatis dibuat di `data/insectpump.db`.

### Step 7: Verifikasi Setup

Jalankan validasi config:

```bash
npm start
```

Kalo ada error missing secrets, cek `.env` lagi.

## Usage

### Development Mode (dengan auto-restart)

```bash
npm run dev
```

### Production Mode

```bash
npm run build
npm start
```

### Mode Eye-Only (monitoring only, no trades)

```bash
npx ts-node src/eye-only.ts
```

### Wallet CLI

Ada Python CLI untuk manage wallet (deposit/withdraw/check balance):

```bash
# Install dependencies untuk wallet CLI
pip3 install solana base58 requests

# Cek balance
python3 scripts/wallet_cli.py balance

# Deposit (show address)
python3 scripts/wallet_cli.py deposit

# Withdraw
python3 scripts/wallet_cli.py withdraw --to <ADDRESS> --amount <SOL>
```

## Project Structure

```
InsectPump/
├── src/
│   ├── config/
│   │   └── config.ts           # Semua parameter strategi
│   ├── database/
│   │   └── tradeBase.ts        # SQLite database operations
│   ├── discovery/
│   │   ├── radar.ts            # L1: MCap filter
│   │   ├── eye.ts              # WSS real-time monitoring
│   │   └── analyzer.ts         # L3/L4: Helius analysis
│   ├── execution/
│   │   ├── tradeEngine.ts      # Buy/sell execution
│   │   ├── raydiumNative.ts    # Native Raydium AMM/CPMM swaps
│   │   ├── meteoraNative.ts    # Native Meteora DLMM swaps
│   │   ├── nativeTypes.ts      # Shared native swap types
│   │   └── walletManager.ts    # Wallet operations
│   ├── monitoring/
│   │   ├── inangMonitor.ts     # Whale tracking
│   │   └── priceMonitor.ts     # Price & PnL tracking
│   ├── services/
│   │   ├── helius.ts           # Helius API client
│   │   └── alchemy.ts          # Alchemy API client
│   ├── types/
│   │   └── index.ts            # TypeScript interfaces
│   ├── utils/
│   │   ├── logger.ts           # Winston logging
│   │   └── telegram.ts         # Telegram notifications
│   ├── main.ts                 # Entry point (full bot)
│   └── eye-only.ts             # Entry point (monitoring only)
├── scripts/
│   └── wallet_cli.py           # Python wallet CLI
├── data/
│   └── insectpump.db           # SQLite database
├── .env.example                # Template environment variables
├── .env                        # Actual environment variables (gitignored)
├── package.json                # Node.js dependencies
└── tsconfig.json               # TypeScript configuration
```

## Troubleshooting

### Error: `Missing required secrets in .env`

Cek `.env` file, pastikan semua required fields terisi:
- PRIVATE_KEY
- HELIUS_RPC_URL
- HELIUS_API_KEY
- ALCHEMY_RPC_URL
- ALCHEMY_API_KEY

### Error: `Cannot find module`

Jalankan:
```bash
npm install
npm run build
```

### Error: `better-sqlite3` native module error

Ini biasanya karena Node.js version mismatch. Coba:

```bash
# Rebuild native modules
npm rebuild better-sqlite3

# Atau reinstall
rm -rf node_modules
npm install
```

### API Key Invalid

Cek `.env` file, pastikan API keys lengkap (gak ada `...` di tengah). Kalo ada pattern kayak `145956...8421` berarti file corrupt dan harus di-edit ulang.

### Bot tidak buying

Cek beberapa hal:
1. Wallet balance cukup (>0.5 SOL)
2. API keys valid (cek log)
3. Filter settings di `config.ts` (maybe too strict?)
4. Eye WSS terkoneksi (cek log "Eye WSS connected")

### High priority fee

Ini normal saat network congestion. Bot akan otomatis adjust priority fee. Kalo mau limit max fee, edit `MAX_PRIORITY_FEE` di `config.ts`.

## API Credits Estimation

**Helius (per trade cycle):**
- L3 Analysis: ~2-3 credits (50 TX)
- Execution: ~1 credit per TX

**Alchemy (per token):**
- L2 Filter: ~1 credit (100 transfers)

**Free tier Alchemy:** 10M credits/bulan (cukup untuk ribuan token)

## License

MIT License - Tuyul Digital

## Disclaimer

Trading crypto beresiko tinggi. Bot ini untuk educational purpose. Selalu do your own research dan jangan trade dengan dana yang tidak sanggup lu rugi.
