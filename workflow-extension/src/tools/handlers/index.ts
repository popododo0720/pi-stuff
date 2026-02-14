// tools/handlers/index.ts — Action handler registry
// Maps action names to independent handler functions.
// Adding a new action = add handler file + register here.

import { handleApprovePlan } from './approve-plan';
import { handleCompoundDone } from './compound-done';
import { handleImplDone } from './impl-done';
import { handleReplan } from './replan';
import { handleSetTodos } from './set-todos';
import type { ActionHandler } from './types';

export const handlers: Record<string, ActionHandler> = {
  approvePlan: handleApprovePlan,
  implDone: handleImplDone,
  compoundDone: handleCompoundDone,
  setTodos: handleSetTodos,
  replan: handleReplan,
};

export type { ActionHandler, HandlerContext, HandlerResult } from './types';
