export const FILE_OPERATIONS = [
  'create',
  'delete',
  'rename',
  'move',
  'modify',
  'overwrite',
] as const;

export type FileOperation = (typeof FILE_OPERATIONS)[number];

export const FILE_PERMISSION_REQUEST_PREFIX = 'filereq_';
export const QUESTION_REQUEST_PREFIX = 'questionreq_';

export interface PermissionRequest {
  id: string;
  taskId: string;
  type: 'tool' | 'question' | 'file';
  toolName?: string;
  toolInput?: unknown;
  question?: string;
  header?: string;
  options?: PermissionOption[];
  multiSelect?: boolean;
  /**
   * SEC-1: true when the agent-authored ask text (header/question/options)
   * matches credential-request language. Header-independent — never keyed on
   * the M6-A assistance header. Restored (pre-SEC-1) records may omit it;
   * UI consumers re-run detection over the text surfaces in that case.
   */
  credentialRisk?: boolean;
  fileOperation?: FileOperation;
  filePath?: string;
  filePaths?: string[];
  targetPath?: string;
  contentPreview?: string;
  timeoutMs?: number;
  createdAt: string;
}

export interface PermissionOption {
  label: string;
  description?: string;
}

export interface PermissionResponse {
  requestId: string;
  taskId: string;
  decision: 'allow' | 'deny';
  message?: string;
  selectedOptions?: string[];
  customText?: string;
}
