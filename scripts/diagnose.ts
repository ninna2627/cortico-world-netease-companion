import { MprisReader } from '../src/reader.ts';
import { defaults } from '../src/config.ts';
if (process.platform !== 'linux') throw new Error('Linux only');
const reader = new MprisReader(defaults());
reader.start(snapshot => console.log(JSON.stringify(snapshot)), message => console.error(message));
const finish = async () => {
  console.log(JSON.stringify(reader.diagnostics(), null, 2));
  await reader.stop();
};
process.once('SIGINT', () => { void finish(); });
setTimeout(() => { void finish(); }, 10_000);
