import { ChannelConnection } from './connection';
import type { BridgeChannel, StartChannelDeps } from './types';

export { ChannelConnection } from './connection';
export { shouldSuppressSdkErrorLog } from './sdk';
export type { BridgeChannel, StartChannelDeps } from './types';

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const connection = await ChannelConnection.create(deps);

  await connection.start();

  return connection;
}
