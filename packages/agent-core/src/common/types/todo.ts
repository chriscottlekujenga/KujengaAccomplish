export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  /**
   * Optional model identifier rendering in the UI (e.g. multi-model project mode
   * assigns each subtask to a specific Ollama Cloud model).
   */
  model?: string;
}
