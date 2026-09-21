import type { RouteServices } from './daemon-routes.js';

/**
 * Forward task service events as RPC notifications.
 */
export function registerTaskEventForwarding(services: RouteServices): void {
  const { rpc, taskService, thoughtStreamService, healthService } = services;

  taskService.on('progress', (data) => {
    rpc.notify('task.progress', data);
  });
  taskService.on('message', (data) => {
    rpc.notify('task.message', data);
  });
  taskService.on('complete', (data) => {
    thoughtStreamService.unregisterTask(data.taskId);
    rpc.notify('task.complete', data);
  });
  taskService.on('error', (data: { taskId: string }) => {
    thoughtStreamService.unregisterTask(data.taskId);
    rpc.notify('task.error', data);
  });
  taskService.on('permission', (data) => {
    rpc.notify('permission.request', data);
  });
  taskService.on('statusChange', (data: { taskId: string; status: string }) => {
    if (data.status === 'running') {
      thoughtStreamService.registerTask(data.taskId);
    } else if (data.status === 'cancelled') {
      thoughtStreamService.unregisterTask(data.taskId);
    }
    healthService.setActiveTaskCount(taskService.getActiveTaskCount());
    rpc.notify('task.statusChange', data);
  });
  taskService.on('summary', (data: { taskId: string; summary: string }) => {
    rpc.notify('task.summary', data);
  });
  taskService.on('todoUpdate', (data: { taskId: string; todos: unknown[] }) => {
    rpc.notify('todo.update', data);
  });
  taskService.on('project-status', (data: { taskId: string; status: unknown }) => {
    rpc.notify('task.projectStatus', data);
  });
  taskService.on('project-plan', (data: { taskId: string; plan: unknown }) => {
    rpc.notify('task.projectPlan', data);
  });
  taskService.on('project-complete', (data: { taskId: string; status: unknown }) => {
    rpc.notify('task.projectComplete', data);
  });
}
