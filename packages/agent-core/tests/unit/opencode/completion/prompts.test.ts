import { describe, it, expect } from 'vitest';
import {
  getContinuationPrompt,
  getPartialContinuationPrompt,
  getRedirectPrompt,
} from '../../../../src/opencode/completion/prompts.js';

describe('Completion Prompts', () => {
  describe('getContinuationPrompt', () => {
    it('should return a reminder prompt', () => {
      const prompt = getContinuationPrompt();

      expect(prompt).toContain('REMINDER: You must call complete_task when finished');
      expect(prompt).toContain('Have I actually finished everything the user asked?');
    });

    it('should include all status options', () => {
      const prompt = getContinuationPrompt();

      expect(prompt).toContain('status: "success"');
      expect(prompt).toContain('status: "blocked"');
      expect(prompt).toContain('status: "partial"');
    });

    it('should encourage continuing work', () => {
      const prompt = getContinuationPrompt();

      expect(prompt).toContain('CONTINUE WORKING');
      expect(prompt).toContain("Keep working if there's more to do");
    });
  });

  describe('getPartialContinuationPrompt', () => {
    it('should include remaining work', () => {
      const prompt = getPartialContinuationPrompt(
        'Item 1\nItem 2',
        'Original request here',
        'Summary of completed work',
      );

      expect(prompt).toContain('Item 1');
      expect(prompt).toContain('Item 2');
    });

    it('should include original request', () => {
      const prompt = getPartialContinuationPrompt(
        'Remaining items',
        'Build a web application',
        'Started setup',
      );

      expect(prompt).toContain('Build a web application');
      expect(prompt).toContain('## Original Request');
    });

    it('should include completed summary', () => {
      const prompt = getPartialContinuationPrompt(
        'Remaining items',
        'Original request',
        'Created project structure and installed dependencies',
      );

      expect(prompt).toContain('Created project structure and installed dependencies');
      expect(prompt).toContain('## What You Completed');
    });

    it('should include continuation plan instructions', () => {
      const prompt = getPartialContinuationPrompt('Remaining', 'Original', 'Completed');

      expect(prompt).toContain('## REQUIRED: Create a Continuation Plan');
      expect(prompt).toContain('Create a TODO list');
    });

    it('should warn against using partial status again', () => {
      const prompt = getPartialContinuationPrompt('Remaining', 'Original', 'Completed');

      expect(prompt).toContain('Do NOT call complete_task with "partial" again');
      expect(prompt).toContain('"partial" is NOT an acceptable final status');
    });

    it('should instruct to use blocked for technical blockers', () => {
      const prompt = getPartialContinuationPrompt('Remaining', 'Original', 'Completed');

      expect(prompt).toContain('login wall, CAPTCHA, rate limit, site error');
      expect(prompt).toContain('"blocked" status');
    });
  });

  describe('getPartialContinuationPrompt with incompleteTodos', () => {
    it('should return a focused todowrite prompt when incompleteTodos provided', () => {
      const prompt = getPartialContinuationPrompt(
        'Remaining',
        'Original',
        'Completed',
        '- Task 1\n- Task 2',
      );

      expect(prompt).toContain('complete_task call was rejected');
      expect(prompt).toContain('- Task 1');
      expect(prompt).toContain('- Task 2');
      expect(prompt).toContain('todowrite');
      expect(prompt).toContain('"completed"');
      expect(prompt).toContain('"cancelled"');
    });

    it('should not include generic continuation plan when incompleteTodos provided', () => {
      const prompt = getPartialContinuationPrompt('Remaining', 'Original', 'Completed', '- Task 1');

      expect(prompt).not.toContain('## REQUIRED: Create a Continuation Plan');
      expect(prompt).not.toContain('## Original Request');
      expect(prompt).not.toContain('## What You Completed');
      expect(prompt).not.toContain('## What You Said Remains');
    });

    it('should not include incomplete todos section when not provided', () => {
      const prompt = getPartialContinuationPrompt('Remaining', 'Original', 'Completed');

      expect(prompt).not.toContain('rejected');
      expect(prompt).toContain('## REQUIRED: Create a Continuation Plan');
    });
  });

  describe('getRedirectPrompt', () => {
    it('should include the user message in quotes', () => {
      const prompt = getRedirectPrompt(['Focus on the login page instead']);

      expect(prompt).toContain('- "Focus on the login page instead"');
    });

    it('should list multiple user messages', () => {
      const prompt = getRedirectPrompt(['First message', 'Second message']);

      expect(prompt).toContain('- "First message"');
      expect(prompt).toContain('- "Second message"');
    });

    it('should instruct the agent to re-plan with todos and keep prior work', () => {
      const prompt = getRedirectPrompt(['Change of plans']);

      expect(prompt).toContain('Create a TODO list');
      expect(prompt).toContain('Build on your existing work');
      expect(prompt).toContain('re-plan');
    });

    it('should preserve complete_task discipline', () => {
      const prompt = getRedirectPrompt(['Change of plans']);

      expect(prompt).toContain('complete_task');
      expect(prompt).toContain('"success"');
      expect(prompt).toContain('"blocked"');
    });
  });
});
