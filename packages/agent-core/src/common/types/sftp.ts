/** A locally encrypted SFTP destination available to Accomplish tasks. */
export interface SftpSite {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** Remote directory the agent is allowed to edit. */
  remoteRoot: string;
  /** Optional SSH private key. When absent, the system SSH agent/default keys are used. */
  privateKeyPath?: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
