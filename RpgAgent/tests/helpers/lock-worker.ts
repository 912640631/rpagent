import { AdventureService } from '../../src/web/service.js';

const [root, id] = process.argv.slice(2);
let service: AdventureService;
try {
  service = new AdventureService(root!);
  service.state(id!);
  process.stdout.write('WEB_READY\n');
} catch (error) {
  process.stderr.write((error as Error).message);
  process.exit(1);
}
process.on('message', async message => {
  if (message === 'close') {
    await service.close();
    process.disconnect();
  }
});
