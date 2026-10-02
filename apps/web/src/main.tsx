import React from 'react';
import { createRoot } from 'react-dom/client';
import { Buffer } from 'buffer';
import App from './App';
// Fonts are bundled and served by the shop itself; no visitor data reaches a font CDN.
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import './style.css';

// @x402/cardano uses the Node Buffer global when decoding a signed payment.
// Install the browser polyfill before any wallet or payment action can run.
const browserGlobals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
browserGlobals.Buffer ??= Buffer;

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
