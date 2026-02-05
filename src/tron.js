import TronWebPkg from 'tronweb';

const TronWeb = TronWebPkg?.default || TronWebPkg;

export const USDT_TRC20_CONTRACT = process.env.USDT_TRC20_CONTRACT || 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

export function tronClient() {
  if (!TronWeb) throw new Error('TronWeb import failed');

  const fullHost = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
  const headers = {};
  const apiKey = process.env.TRON_API_KEY || process.env.TRONGRID_API_KEY;
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  return new TronWeb({ fullHost, headers });
}

export async function createTronAccount() {
  if (!TronWeb) throw new Error('TronWeb import failed');
  const createFn = TronWeb.createAccount || TronWeb?.utils?.accounts?.generateAccount;
  if (!createFn) throw new Error('TronWeb.createAccount not available');
  const acc = await createFn();
  const address = acc?.address?.base58 || acc?.address;
  const privateKey = acc?.privateKey;
  if (!address || !privateKey) throw new Error('Failed to create TRON account');
  return { address, privateKey };
}

export function usdtToBaseUnits(amountUsdt) {
  return String(Math.round(Number(amountUsdt) * 1_000_000));
}

export async function fetchRecentUsdtTransfersTo(addressBase58, limit = 50) {
  const client = tronClient();
  const base = client.fullHost || process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
  const apiKey = process.env.TRON_API_KEY || process.env.TRONGRID_API_KEY;

  const url = `${String(base).replace(/\/$/, '')}/v1/accounts/${addressBase58}/transactions/trc20?limit=${limit}&contract_address=${USDT_TRC20_CONTRACT}`;
  const res = await fetch(url, { headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {} });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TronGrid error ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.data || [];
}
