// Boot sequence (BootSequenceLineByLine.cs): terminal log line by line, memory
// counter, then the Amadeus logo. Tap to skip; skipped entirely by the setting.

import { se } from '../audio/se';
import { settings } from '../settings';
import { $, el } from './dom';

const BOOT_LOG = `Amadeus System Ver 1.09.2 rev.2123
>>Initialize System ...  OK
>>Detecting boot device ... OK
>>Loading Kerner ...  OK
>>Detecting OS control device ...  OK
>>Booting ...
>>Processor 0 is Activate ...  OK
>>Processor 1 is Activate ...  OK
>>Processor 2 is Activate ...  OK
>>Processor 3 is Activate ...  OK
>>Memory Initialize [MEM]/32767MBytes
INIT: Kernel version 2.04 booting...

ROSS:
Mounting proc at /proc...|[OK]
Mounting sysfs at /sts...|[OK]
Initakising network|[OK]
Setting up localhost ...|[OK]
Setting up inet1 ...|[OK]
Setting up route ...|[OK]
Accessing Croud ...|[OK]
Starting system log at /log/sys...|[OK]
Cleaning /var/lock|[OK]
Cleaning /tmp|[OK]
Updating init.rc|[OK]
Boot Sequences Start...`;

const LINE_DELAY = 50;
const SLOW_DELAY = 400;
const COUNT_MS = 1500;
const MAX_MEMORY = 32767;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function renderLine(line: string, mem: number): Node {
  const text = line.replace('[MEM]', String(mem));
  const bar = text.indexOf('|');
  if (bar < 0) return document.createTextNode(text + '\n');
  // "<pos=30%>[OK]" in the TextMeshPro original: status aligned in a column.
  const label = text.slice(0, bar);
  const frag = document.createDocumentFragment();
  frag.append(label.padEnd(36, ' '), el('span.ok', { text: text.slice(bar + 1) }), '\n');
  return frag;
}

export async function runBoot(): Promise<void> {
  if (settings.get().skipLoading) return;
  const screen = $('#screen-boot');
  const term = $('#boot-terminal');
  const logo = $('#boot-logo');
  term.textContent = '';
  logo.hidden = true;
  screen.hidden = false;

  let skipped = false;
  const skip = () => (skipped = true);
  screen.addEventListener('pointerdown', skip);
  const sleep = async (ms: number) => {
    const end = performance.now() + ms;
    while (!skipped && performance.now() < end) await wait(Math.min(50, end - performance.now()));
  };

  try {
    await sleep(500);
    for (const line of BOOT_LOG.split('\n')) {
      if (skipped) break;
      if (line.includes('[MEM]')) {
        const node = document.createElement('span');
        term.append(node);
        const start = performance.now();
        for (;;) {
          const p = Math.min(1, (performance.now() - start) / COUNT_MS);
          node.textContent = '';
          node.append(renderLine(line, Math.floor(MAX_MEMORY * p)));
          if (p >= 1 || skipped) break;
          await wait(16);
        }
        await sleep(SLOW_DELAY);
        continue;
      }
      term.append(renderLine(line, 0));
      await sleep(line.includes('...') || !line.trim() ? SLOW_DELAY : LINE_DELAY);
    }
    await sleep(2000);
    term.textContent = '';
    logo.hidden = false;
    se('boot');
    await sleep(4000);
  } finally {
    screen.removeEventListener('pointerdown', skip);
    screen.hidden = true;
    logo.hidden = true;
  }
}
