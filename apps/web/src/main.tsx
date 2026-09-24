import React from 'react';
import { createRoot } from 'react-dom/client';
import { Buffer } from 'buffer';
import App from './App';
import './style.css';

// @x402/cardano uses the Node Buffer global when decoding a signed payment.
// Install the browser polyfill before any wallet or payment action can run.
const browserGlobals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
browserGlobals.Buffer ??= Buffer;

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
