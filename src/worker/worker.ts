import { expose, transfer } from 'comlink';
import type { JobControl, WorkerApi } from '../core/types';
import { createWorkerApi } from './api';

const api = createWorkerApi();
const withProgress = (control: JobControl, onProgress?: JobControl['onProgress']): JobControl =>
  onProgress ? { ...control, onProgress } : control;

const transferableApi: WorkerApi = {
  ...api,
  smartTrace: (request, control, onProgress?: JobControl['onProgress']) =>
    api.smartTrace(request, withProgress(control, onProgress)),
  refineTrail: (request, control, onProgress?: JobControl['onProgress']) =>
    api.refineTrail(request, withProgress(control, onProgress)),
  scanColors: (imageId, control, onProgress?: JobControl['onProgress']) =>
    api.scanColors(imageId, withProgress(control, onProgress)),
  autoTrace: (request, control, onProgress?: JobControl['onProgress']) =>
    api.autoTrace(request, withProgress(control, onProgress)),
  buildKmz: async (request, control, onProgress?: JobControl['onProgress']) => {
    const bytes = await api.buildKmz(request, withProgress(control, onProgress));
    return transfer(bytes, [bytes.buffer]);
  },
};

expose(transferableApi);
