import { AdventureService } from '../../src/web/service.js';

const [root, id, snapshot] = process.argv.slice(2);
const service = new AdventureService(root!);
try { await service.restore(id!, snapshot!); }
finally { await service.close(); }
