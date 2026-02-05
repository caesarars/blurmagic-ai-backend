import { ethers } from 'ethers';

export const USDT_BEP20_CONTRACT = (process.env.USDT_BEP20_CONTRACT || '0x55d398326f99059fF775485246999027B3197955').toLowerCase();
export const BSC_CHAIN_ID = 56;

export function getMerchantAddress() {
  const addr = process.env.MERCHANT_BSC_ADDRESS || process.env.MERCHANT_WALLET_ADDRESS;
  if (!addr) throw new Error('Missing MERCHANT_BSC_ADDRESS');
  return ethers.getAddress(addr);
}

export function bscProvider() {
  const url = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
  return new ethers.JsonRpcProvider(url, BSC_CHAIN_ID);
}

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export async function verifyUsdtBep20Transfer({ txid, toAddress, amountUsdt }) {
  if (!txid) throw new Error('Missing txid');
  const provider = bscProvider();

  const receipt = await provider.getTransactionReceipt(txid);
  if (!receipt) return { ok: true, found: false, reason: 'pending' };
  if (receipt.status !== 1) return { ok: true, found: false, reason: 'failed' };

  const iface = new ethers.Interface(ERC20_ABI);

  const expectedTo = ethers.getAddress(toAddress);
  const expectedValue = ethers.parseUnits(String(amountUsdt), 18); // USDT on BSC uses 18 decimals

  for (const log of receipt.logs) {
    if (!log?.address) continue;
    if (String(log.address).toLowerCase() !== USDT_BEP20_CONTRACT) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'Transfer') continue;

    const to = parsed.args?.to;
    const value = parsed.args?.value;

    if (ethers.getAddress(to) === expectedTo && value === expectedValue) {
      return {
        ok: true,
        found: true,
        from: parsed.args?.from,
        to,
        value: value.toString(),
        blockNumber: receipt.blockNumber,
      };
    }
  }

  return { ok: true, found: false, reason: 'no_match' };
}
