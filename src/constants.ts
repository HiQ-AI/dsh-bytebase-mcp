export const PACKAGE_NAME = '@zzusp/dsh-bytebase-mcp'
export const PLUGIN_NAME = 'bytebase-mcp'
export const SERVER_NAME = 'bytebase'
export const DEFAULT_SERVER_URL = 'https://bytebase.hiqdat.dev/mcp'
export const DEFAULT_CALLBACK_PORT = 14_801
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000
export const AUTH_FILENAME = '.bytebase-mcp-auth.json'

export const ALLOWED_MCP_TOOLS = Object.freeze([
  'search_api',
  'get_skill',
  'get_schema',
  'query_database',
  'propose_database_change',
  'call_api',
] as const)

export const READ_CALL_OPERATIONS = Object.freeze([
  'bytebase.v1.IssueService.GetIssue',
  'bytebase.v1.IssueService.ListIssueComments',
  'bytebase.v1.PlanService.GetPlan',
  'bytebase.v1.PlanService.GetPlanCheckRun',
  'bytebase.v1.RolloutService.GetRollout',
  'bytebase.v1.RolloutService.ListTaskRuns',
  'bytebase.v1.RolloutService.GetTaskRun',
  'bytebase.v1.RolloutService.GetTaskRunLog',
] as const)

export const MUTATING_CALL_OPERATIONS = Object.freeze([
  'bytebase.v1.RolloutService.CreateRollout',
  'bytebase.v1.RolloutService.BatchRunTasks',
] as const)
