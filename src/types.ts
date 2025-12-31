import type { Db } from './db.js';
import type { AppConfig } from './config.js';
import type { ClashApi } from './clashApi.js';

export type AppContext = {
  cfg: AppConfig;
  db: Db;
  clash: ClashApi;
};
