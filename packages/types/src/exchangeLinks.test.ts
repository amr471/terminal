import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeTradeUrl } from './exchangeLinks.js';

test('exchangeTradeUrl: binance', () => {
  assert.equal(exchangeTradeUrl('binance', 'btcusdt'), 'https://www.binance.com/en/futures/BTCUSDT');
});

test('exchangeTradeUrl: bybit', () => {
  assert.equal(exchangeTradeUrl('bybit', 'ethusdt'), 'https://www.bybit.com/trade/usdt/ETHUSDT');
});

test('exchangeTradeUrl: okx', () => {
  assert.equal(exchangeTradeUrl('okx', 'solusdt'), 'https://www.okx.com/trade-swap/sol-usdt-swap');
});

test('exchangeTradeUrl: hyperliquid uses the base asset only, no quote', () => {
  assert.equal(exchangeTradeUrl('hyperliquid', 'btcusdt'), 'https://app.hyperliquid.xyz/trade/BTC');
});

test('exchangeTradeUrl: kucoin renames BTC to XBT and appends M', () => {
  assert.equal(exchangeTradeUrl('kucoin', 'btcusdt'), 'https://www.kucoin.com/trade/futures/XBTUSDTM');
  assert.equal(exchangeTradeUrl('kucoin', 'ethusdt'), 'https://www.kucoin.com/trade/futures/ETHUSDTM');
});

test('exchangeTradeUrl: aster', () => {
  assert.equal(exchangeTradeUrl('aster', 'dymusdt'), 'https://www.asterdex.com/en/trade/pro/futures/DYMUSDT');
});

test('exchangeTradeUrl: mexc uses an underscore separator', () => {
  assert.equal(exchangeTradeUrl('mexc', 'btcusdt'), 'https://www.mexc.com/futures/BTC_USDT');
});

test('exchangeTradeUrl: bingx uses a hyphen separator', () => {
  assert.equal(exchangeTradeUrl('bingx', 'btcusdt'), 'https://bingx.com/en/perpetual/BTC-USDT');
});

test('exchangeTradeUrl: unrecognized venue returns null rather than a broken link', () => {
  assert.equal(exchangeTradeUrl('coinbase', 'btcusdt'), null);
  assert.equal(exchangeTradeUrl('', 'btcusdt'), null);
});

test('exchangeTradeUrl: symbol case is normalized regardless of input casing', () => {
  assert.equal(exchangeTradeUrl('binance', 'BTCUSDT'), 'https://www.binance.com/en/futures/BTCUSDT');
});
