// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for truki-bridge, spoken to over newline-delimited JSON-RPC.
// Only active when FAKE_TRUKI_BRIDGE=1, because mocha also loads every .mjs
// file under ts/test-node.
//
// Env: FAKE_PROTOCOL (default 1), FAKE_CRASH_ON_START, FAKE_KEY_OUT (file to
// write the received dbKey to), FAKE_HANG_SHUTDOWN, FAKE_EVENT_BEFORE_INIT.

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

if (process.env.FAKE_TRUKI_BRIDGE === '1') {
  if (process.env.FAKE_CRASH_ON_START === '1') {
    process.exit(1);
  }

  const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);

  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    const reply = result => send({ jsonrpc: '2.0', id, result });

    switch (method) {
      case 'init':
        if (process.env.FAKE_KEY_OUT) {
          writeFileSync(process.env.FAKE_KEY_OUT, params.dbKey);
        }
        if (process.env.FAKE_EVENT_BEFORE_INIT === '1') {
          send({
            jsonrpc: '2.0',
            method: 'event.early',
            params: { n: 0 },
          });
        }
        reply({
          protocolVersion: Number(process.env.FAKE_PROTOCOL ?? '1'),
          bridgeVersion: 'fake',
          networks: [],
        });
        break;
      case 'echo':
        reply(params);
        break;
      case 'echoLater':
        setTimeout(() => reply(params.value), params.ms);
        break;
      case 'emit':
        send({ jsonrpc: '2.0', method: 'event.test', params: { n: 1 } });
        reply({});
        break;
      case 'crash':
        process.exit(3);
        break;
      case 'hang':
        break;
      case 'shutdown':
        if (process.env.FAKE_HANG_SHUTDOWN !== '1') {
          reply({});
          process.exit(0);
        }
        break;
      default:
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'unknown method',
            data: { code: 'INVALID_INPUT' },
          },
        });
    }
  });
}
