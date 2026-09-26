import { PassThrough, Readable } from 'stream';
import { BackupsController } from '../src/backups/backups.controller';
function response() {
  const res = new PassThrough() as any;
  res.setHeader = jest.fn();
  res.status = jest.fn().mockReturnValue(res);
  res.resume();
  return res;
}
describe('backup download streaming', () => {
  it('streams the file and supplies its length', async () => {
    const service = { getBackupFileForDownload: jest.fn().mockResolvedValue({
      fileName: 'backup.zip', sizeBytes: 3, stream: Readable.from(['zip']),
    }) };
    const controller = new BackupsController(service as any);
    const res = response();
    let output = '';
    res.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await controller.downloadBackup('backup.zip', res);
    expect(output).toBe('zip');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '3');
  });
  it('limits concurrency and releases slots after lookup failure', async () => {
    const rejectors: Array<(error: Error) => void> = [];
    const service = { getBackupFileForDownload: jest.fn().mockImplementation(() =>
      new Promise((_, reject) => rejectors.push(reject))) };
    const controller = new BackupsController(service as any);
    const first = controller.downloadBackup('a.zip', response()).catch(error => error);
    const second = controller.downloadBackup('b.zip', response()).catch(error => error);
    await expect(controller.downloadBackup('c.zip', response())).rejects.toMatchObject({ status: 429 });
    rejectors.forEach(reject => reject(new Error('missing')));
    await Promise.all([first, second]);
    service.getBackupFileForDownload.mockResolvedValue({ fileName: 'c.zip', sizeBytes: 1, stream: Readable.from(['x']) });
    await controller.downloadBackup('c.zip', response());
    expect(service.getBackupFileForDownload).toHaveBeenCalledTimes(3);
  });
});
