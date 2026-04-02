# stc-guardian

Workflow enforcement MCP server for AI-assisted development.

Tracks development phases, blocks premature commits, enforces code review — works with any AI coding assistant that supports [MCP](https://modelcontextprotocol.io/).

## What it does

stc-guardian enforces a structured development workflow by tracking phases and blocking transitions until requirements are met.

**Default pipeline (STC — Spec-Test-Code):**

```
specify → clarify → plan → test → code → verify → commit
```

- `specify` — write a spec before coding
- `test` — write tests before implementation (required, can't be skipped)
- `verify` — run code review + security check before committing (hard gate)
- `commit` — only allowed after verify passes

You can define **custom pipelines** with your own phases and rules.

## Quick start

### 1. Install

```bash
git clone https://github.com/skyp0wer/stc-guardian.git
cd stc-guardian
npm install
npm run build
```

### 2. Add to your AI assistant

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "guardian": {
      "command": "node",
      "args": ["/path/to/stc-guardian/dist/index.js"],
      "env": {
        "GUARDIAN_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

The server communicates over **stdio** (MCP standard).

### 3. Init project

Create `.stc/` directory in your project root:

```bash
mkdir .stc
```

Guardian will auto-create `state.json` on first tool call.

### 4. Use

```
feature_register(name: "my-feature", spec_path: ".claude/specs/my-feature.md")
phase_status()          → shows current phase + action_required
phase_advance()         → move to next phase
verify_checklist(...)   → submit review results before commit
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `feature_register` | Register a new feature for tracking (with optional `pipeline` param) |
| `feature_scan` | Auto-discover features from `.claude/specs/` directory |
| `feature_list` | List all features and their statuses |
| `feature_switch` | Switch active feature |
| `phase_status` | Current phase + `action_required` instruction |
| `phase_advance` | Transition to next phase (with rule enforcement) |
| `verify_checklist` | Submit code review / security check results (required before commit) |
| `step_set` | Set atomic steps for the current feature |
| `session_log` | View audit trail |

## Custom pipelines

### Built-in pipeline

**`stc`** (default) — full development cycle:
```
specify → clarify → plan → test → code → verify → commit
```

### Define your own

Create `.stc/config.yaml` in your project:

```yaml
pipeline:
  name: my-workflow
  phases:
    - name: design
      required: true
    - name: review
      required: false        # can be skipped with skip_reason
    - name: implement
      required: true
    - name: test
      required: true
      satisfiable: true       # can be satisfied with evidence instead of doing
      satisfy_min_length: 50  # minimum evidence length
    - name: qa
      required: true
    - name: ship
      terminal: true          # last phase, triggers step cycling if steps defined
```

### Phase options

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Phase name (unique within pipeline) |
| `required` | boolean | If `true`, phase cannot be skipped |
| `terminal` | boolean | Marks the last phase. Triggers step cycling |
| `satisfiable` | boolean | Can be satisfied with evidence instead of doing |
| `satisfy_min_length` | number | Minimum length of satisfy evidence |

### Step cycling

For multi-step features, set steps with `step_set`. When the terminal phase completes, the pipeline resets to the first required phase (e.g., `test`) for the next step — until all steps are done.

### Register with a custom pipeline

```
feature_register(name: "my-feature", pipeline: "my-workflow")
```

## Key concepts

### Verify gate

The `verify` phase is a hard gate — you can't advance past it without calling `verify_checklist` with agent results:

```
verify_checklist(
  code_review: "passed",
  security_check: "passed_with_notes",
  spec_check: { skipped: "no spec for this feature" }
)
```

Possible results: `"passed"`, `"passed_with_notes"`, `"failed"`, `{ skipped: "reason" }`.

If `code_review` is `"failed"` — verify blocks.

### State persistence

All state is stored in `.stc/state.json` (add to `.gitignore`). Audit log in `.stc/log.jsonl`.

### Action required

Every `phase_status` response includes an `action_required` field — a human-readable instruction for what to do next. AI assistants can follow these automatically.

## The STC Method

stc-guardian implements the **Spec-Test-Code** method — a structured approach to AI-assisted development:

1. **Spec first** — write what you're building before writing code
2. **Test from spec** — generate tests from spec scenarios (Given-When-Then)
3. **Code to green** — write code until tests pass
4. **Verify before commit** — code review + security check on every commit

The method is tool-agnostic. The guardian is an optional enforcement layer.

## Development

```bash
npm install
npm test          # 138 tests
npm run build     # compile TypeScript
```

## License

MIT — see [LICENSE](LICENSE).

## Author

**Skyp0wer** — [github.com/skyp0wer](https://github.com/skyp0wer)
