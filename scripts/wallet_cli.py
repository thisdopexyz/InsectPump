#!/usr/bin/env python3
"""
InsectPump Wallet CLI - Standalone wallet report tool
Bisa jalan tanpa bot nyala, query langsung ke database + RPC

Usage:
  python wallet_cli.py          # Full wallet report
  python wallet_cli.py --holdings   # Cuma list holdings
  python wallet_cli.py --refresh    # Force refresh semua data

Commands mirip Telegram bot:
  /wallet  → python wallet_cli.py
  /holdings → python wallet_cli.py --holdings
  /stats   → python wallet_cli.py --json (buat parsing)
"""

import os
import sys
import json
import sqlite3
import argparse
from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

# Load .env
from dotenv import load_dotenv
load_dotenv(os.path.expanduser('~/InsectPump/.env'))

# Solana
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.api import Client
from solana.rpc.types import MemcmpOpts

# Constants
DB_PATH = os.path.expanduser('~/InsectPump/data/trades.db')
SOL_MINT = "So11111111111111111111111111111111111111112"
LAMPORTS_PER_SOL = 1_000_000_000

class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def log(msg: str, color: str = ""):
    print(f"{color}{msg}{Colors.ENDC if color else ''}")

class WalletCLI:
    def __init__(self):
        self.db_path = DB_PATH
        self.rpc_url = os.getenv('HELIUS_RPC_URL') or os.getenv('ALCHEMY_RPC_URL')
        self.private_key = os.getenv('PRIVATE_KEY')
        
        if not self.rpc_url:
            log("❌ Error: RPC URL gak ketemu di .env", Colors.RED)
            sys.exit(1)
        
        if not self.private_key:
            log("❌ Error: PRIVATE_KEY gak ketemu di .env", Colors.RED)
            sys.exit(1)
        
        self.client = Client(self.rpc_url)
        self.keypair = Keypair.from_base58_string(self.private_key)
        self.wallet_address = str(self.keypair.pubkey())
        
    def get_sol_balance(self) -> float:
        """Ambil SOL balance wallet"""
        try:
            response = self.client.get_balance(self.keypair.pubkey())
            if response.value is not None:
                return response.value / LAMPORTS_PER_SOL
            return 0.0
        except Exception as e:
            log(f"⚠️ Gagal ambil SOL balance: {e}", Colors.YELLOW)
            return 0.0
    
    def get_token_accounts(self) -> List[Dict]:
        """Ambil semua token accounts (ATA) yang dimiliki wallet"""
        try:
            response = self.client.get_token_accounts_by_owner(
                self.keypair.pubkey(),
                {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}
            )
            
            tokens = []
            for account in response.value:
                parsed = account.account.data.parsed['info']
                mint = parsed['mint']
                balance = int(parsed['tokenAmount']['amount'])
                decimals = parsed['tokenAmount']['decimals']
                
                if balance > 0:  # Cuma yang ada balance
                    tokens.append({
                        'mint': mint,
                        'balance': balance / (10 ** decimals),
                        'decimals': decimals
                    })
            
            return tokens
        except Exception as e:
            log(f"⚠️ Gagal ambil token accounts: {e}", Colors.YELLOW)
            return []
    
    def get_db_connection(self) -> sqlite3.Connection:
        """Connect ke database"""
        if not os.path.exists(self.db_path):
            log(f"❌ Database gak ketemu: {self.db_path}", Colors.RED)
            sys.exit(1)
        return sqlite3.connect(self.db_path)
    
    def get_open_trades(self) -> List[Dict]:
        """Ambil posisi terbuka dari database"""
        conn = self.get_db_connection()
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT * FROM trades 
            WHERE status = 'OPEN' 
            ORDER BY buy_time DESC
        """)
        
        trades = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return trades
    
    def get_trade_stats(self) -> Dict:
        """Hitung statistik trading dari database"""
        conn = self.get_db_connection()
        cursor = conn.cursor()
        
        # Total trades
        cursor.execute("SELECT COUNT(*) FROM trades")
        total_trades = cursor.fetchone()[0]
        
        # Closed trades
        cursor.execute("""
            SELECT COUNT(*), SUM(sell_amount - buy_amount) as total_pnl
            FROM trades 
            WHERE status = 'CLOSED'
        """)
        row = cursor.fetchone()
        closed_count = row[0] or 0
        total_pnl = row[1] or 0
        
        # Winning trades (PnL > 0)
        cursor.execute("""
            SELECT COUNT(*) FROM trades 
            WHERE status = 'CLOSED' AND sell_amount > buy_amount
        """)
        wins = cursor.fetchone()[0] or 0
        
        # Losing trades
        cursor.execute("""
            SELECT COUNT(*) FROM trades 
            WHERE status = 'CLOSED' AND sell_amount <= buy_amount
        """)
        losses = cursor.fetchone()[0] or 0
        
        winrate = (wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
        
        # Inangs
        cursor.execute("SELECT COUNT(*) FROM inangs WHERE is_active = 1")
        active_inangs = cursor.fetchone()[0] or 0
        
        conn.close()
        
        return {
            'total_trades': total_trades,
            'closed_trades': closed_count,
            'wins': wins,
            'losses': losses,
            'winrate': winrate,
            'total_pnl_sol': total_pnl,
            'active_inangs': active_inangs
        }
    
    def estimate_token_price(self, token_address: str) -> Optional[float]:
        """Estimasi harga token dari Jupiter (fallback ke rough estimate)"""
        # Untuk sekarang return None, nanti bisa ditambahin Jupiter API
        return None
    
    def format_time_ago(self, timestamp: str) -> str:
        """Format timestamp jadi 'X hours ago'"""
        try:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            now = datetime.now(dt.tzinfo)
            diff = now - dt
            
            if diff.days > 0:
                return f"{diff.days}d ago"
            hours = diff.seconds // 3600
            if hours > 0:
                return f"{hours}h ago"
            mins = diff.seconds // 60
            return f"{mins}m ago"
        except:
            return "unknown"
    
    def print_wallet_report(self, json_output: bool = False):
        """Print laporan wallet lengkap"""
        if json_output:
            # Mode JSON buat parsing script lain
            data = {
                'wallet': self.wallet_address,
                'timestamp': datetime.now().isoformat(),
                'sol_balance': self.get_sol_balance(),
                'open_trades': self.get_open_trades(),
                'stats': self.get_trade_stats()
            }
            print(json.dumps(data, indent=2, default=str))
            return
        
        # Header
        log("╔══════════════════════════════════════════════════════════╗", Colors.CYAN)
        log("║           INSECTPUMP WALLET REPORT                       ║", Colors.CYAN)
        log("╚══════════════════════════════════════════════════════════╝", Colors.CYAN)
        log(f"\n📍 Wallet: {Colors.YELLOW}{self.wallet_address[:20]}...{self.wallet_address[-8:]}{Colors.ENDC}")
        log(f"🕐 Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        
        # SOL Balance
        sol_balance = self.get_sol_balance()
        sol_price = 0  # Bisa ditambahin fetch dari API
        sol_value_usd = sol_balance * sol_price
        
        log("💰 BALANCE", Colors.BOLD + Colors.GREEN)
        log(f"   SOL Balance: {Colors.GREEN}{sol_balance:.4f} SOL{Colors.ENDC}")
        log(f"   Wallet Address: {self.wallet_address}")
        
        # Trade Stats
        stats = self.get_trade_stats()
        log("\n📊 TRADE STATISTICS", Colors.BOLD + Colors.GREEN)
        log(f"   Total Trades: {stats['total_trades']}")
        log(f"   Closed: {stats['closed_trades']} | Open: {stats['total_trades'] - stats['closed_trades']}")
        
        pnl_color = Colors.GREEN if stats['total_pnl_sol'] >= 0 else Colors.RED
        pnl_sign = "+" if stats['total_pnl_sol'] >= 0 else ""
        log(f"   Total PnL: {pnl_color}{pnl_sign}{stats['total_pnl_sol']:.4f} SOL{Colors.ENDC}")
        
        winrate_color = Colors.GREEN if stats['winrate'] >= 50 else Colors.YELLOW if stats['winrate'] >= 30 else Colors.RED
        log(f"   Win Rate: {winrate_color}{stats['winrate']:.1f}%{Colors.ENDC} ({stats['wins']}W/{stats['losses']}L)")
        log(f"   Active Inangs: {stats['active_inangs']}")
        
        # Open Holdings
        open_trades = self.get_open_trades()
        log(f"\n🪙 HOLDINGS ({len(open_trades)} positions)", Colors.BOLD + Colors.GREEN)
        
        if not open_trades:
            log("   (No open positions)", Colors.YELLOW)
        else:
            # Header table
            log(f"{'#':<3} {'Symbol':<10} {'Entry':<12} {'Qty':<12} {'Age':<8} {'Trailing'}")
            log("─" * 65)
            
            for i, trade in enumerate(open_trades, 1):
                symbol = trade.get('token_symbol', 'UNKNOWN')[:10]
                entry = trade.get('entry_price', 0)
                qty = trade.get('token_amount', 0)
                age = self.format_time_ago(trade.get('buy_time', ''))
                trailing = "🟢 ON" if trade.get('is_trailing_active') else "⏸️ OFF"
                
                # Truncate qty kalo kepanjangan
                qty_str = f"{qty:.4f}" if qty < 1000000 else f"{qty:.2e}"
                
                log(f"{i:<3} {symbol:<10} {entry:<12.6f} {qty_str:<12} {age:<8} {trailing}")
                
                # Show stop loss kalo ada
                if trade.get('stop_loss_price'):
                    sl = trade.get('stop_loss_price')
                    log(f"    └─ Stop Loss: {sl:.6f}")
        
        # Token accounts (on-chain, gak semua ada di database)
        log("\n🔗 ON-CHAIN TOKENS", Colors.BOLD + Colors.GREEN)
        tokens = self.get_token_accounts()
        if not tokens:
            log("   (No tokens found on-chain)", Colors.YELLOW)
        else:
            log(f"   Found {len(tokens)} token accounts with balance")
            for token in tokens[:5]:  # Cuma show 5 pertama
                mint_short = f"{token['mint'][:8]}...{token['mint'][-4:]}"
                log(f"   • {mint_short}: {token['balance']:.6f}")
            if len(tokens) > 5:
                log(f"   ... and {len(tokens) - 5} more")
        
        # Footer
        log("\n" + "═" * 60, Colors.CYAN)
        log("Commands: /wallet, /holdings, /stats", Colors.CYAN)
        log("═" * 60, Colors.CYAN)
    
    def print_holdings_only(self):
        """Print cuma list holdings (kayak /holdings di Telegram)"""
        sol_balance = self.get_sol_balance()
        open_trades = self.get_open_trades()
        
        log("📋 CURRENT HOLDINGS", Colors.BOLD + Colors.CYAN)
        log(f"💰 SOL Balance: {Colors.GREEN}{sol_balance:.4f} SOL{Colors.ENDC}")
        log(f"🪙 Open Positions: {len(open_trades)}\n")
        
        if not open_trades:
            log("_No open positions_", Colors.YELLOW)
            return
        
        for i, trade in enumerate(open_trades[:15], 1):
            trailing = "🟢" if trade.get('is_trailing_active') else "⏸️"
            symbol = trade.get('token_symbol', 'UNKNOWN')
            entry = trade.get('entry_price', 0)
            log(f"{i}. {symbol} @ {entry:.6f} {trailing}")
        
        if len(open_trades) > 15:
            log(f"... and {len(open_trades) - 15} more")

def main():
    parser = argparse.ArgumentParser(
        description='InsectPump Wallet CLI - Standalone wallet report',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python wallet_cli.py              # Full report
  python wallet_cli.py --holdings   # Holdings only
  python wallet_cli.py --json       # JSON output
  python wallet_cli.py --refresh    # Force refresh data
        """
    )
    
    parser.add_argument('--holdings', '-H', action='store_true',
                        help='Show only holdings list')
    parser.add_argument('--json', '-J', action='store_true',
                        help='Output as JSON (for scripting)')
    parser.add_argument('--refresh', '-R', action='store_true',
                        help='Force refresh all data')
    
    args = parser.parse_args()
    
    # Check dependencies
    try:
        cli = WalletCLI()
    except ImportError as e:
        log(f"❌ Missing dependency: {e}", Colors.RED)
        log("Install: pip install solana solders python-dotenv", Colors.YELLOW)
        sys.exit(1)
    except Exception as e:
        log(f"❌ Init error: {e}", Colors.RED)
        sys.exit(1)
    
    # Execute
    try:
        if args.holdings:
            cli.print_holdings_only()
        else:
            cli.print_wallet_report(json_output=args.json)
    except KeyboardInterrupt:
        log("\n\n👋 Bye!", Colors.CYAN)
    except Exception as e:
        log(f"\n❌ Error: {e}", Colors.RED)
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
