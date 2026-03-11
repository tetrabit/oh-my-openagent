# OpenCode Bandwidth Investigation

Date of write-up: 2026-03-10
Investigated event date: 2026-03-09
Host context: `/root`, primary repo involved: `/root/projects/koreader`

## Executive Summary

The high-bandwidth process was `opencode`, not the shell itself.

At approximately `2026-03-09 20:07 EDT`, the active `opencode` process in the `tmux` pane rooted at `/root/projects/koreader` was sending roughly `24,067,780` bytes over a 3-second sample, or about `64 Mbps` outbound, primarily to `172.65.90.20-23:443`.

Those four IPs resolve to `opencode.ai` and sit behind Cloudflare.

This does not look like passive telemetry. The local evidence shows that older OpenCode subagent sessions were still actively running or retrying background model work around `2026-03-09 20:08-20:13 EDT`, even though the shell pane appeared idle to the user. The later DB messages for those sessions are tagged with:

- `providerID = "opencode"`
- `modelID = "minimax-m2.5-free"` in most cases
- `modelID = "big-pickle"` in one case

That means the data movement is best explained as hosted inference traffic to OpenCode's provider path, not generic analytics/telemetry.

## Bottom Line

1. The pane was visually idle, but the `opencode` process was not idle.
2. Multiple background subagent sessions attached to the older `koreader` work were still producing new assistant messages.
3. Those background messages were using OpenCode-hosted providers, not purely local processing.
4. The heavy upload to `opencode.ai` is consistent with model/context transfer.
5. I did not find a clear public statement that the CLI independently emits large anonymous telemetry payloads. The observed traffic is much more consistent with active inference work than with telemetry.

## Files and Evidence Locations

Primary local evidence:

- DB: `/root/.local/share/opencode/opencode.db`
- Logs: `/root/.local/share/opencode/log/`
- Config: `/root/.config/opencode/opencode.json`
- Session diff store: `/root/.local/share/opencode/storage/session_diff/`
- Session helper metadata: `/root/.local/share/opencode/storage/`
- Tmux pane involved: pane `1:4.0`, TTY `/dev/pts/5`, cwd `/root/projects/koreader`

Primary external documentation reviewed:

- `https://opencode.ai/`
- `https://opencode.ai/docs/`
- `https://opencode.ai/docs/providers/`
- `https://opencode.ai/docs/zen/`
- `https://opencode.ai/docs/share/`
- `https://opencode.ai/docs/enterprise/`
- `https://opencode.ai/legal/privacy-policy`
- `https://opencode.ai/legal/terms-of-service`
- `https://github.com/anomalyco/opencode?tab=security-ov-file#readme`
- `https://raw.githubusercontent.com/anomalyco/opencode/dev/SECURITY.md`

## Network Findings

### Active network sample at time of investigation

The strongest per-process sample collected was:

```text
pid=4006461 name=opencode sent=24067780 recv=656 total=24068436 active_conns=4
```

This was a 3-second sample, which is approximately:

- `24,067,780 bytes / 3s`
- about `8.0 MB/s`
- about `64 Mbps` outbound

Top sockets in that sample:

```text
172.65.90.22:443  sent=9,534,360
172.65.90.21:443  sent=8,706,412
172.65.90.21:443  sent=5,827,008
```

Other processes were negligible by comparison.

### Process attribution

The active process at the time was:

```text
PID 4006461
CMD opencode -s ses_32d6e8c40ffewF7wRWyP1rQ1HI
CWD /root/projects/koreader
PARENT /bin/bash in tmux/byobu on pts/5
```

The process tree showed this process under the `tmux` pane in `/root/projects/koreader`, along with related child tooling such as `lua-language-server`, `bash-language-server`, and an SSH helper.

### Remote endpoint attribution

Observed hot IPs:

- `172.65.90.20`
- `172.65.90.21`
- `172.65.90.22`
- `172.65.90.23`

Current resolution checks showed these map to `opencode.ai` address space behind Cloudflare.

Other minor or incidental connections observed at the time:

- `140.82.114.21` -> GitHub load balancer
- `100.25.180.41` -> AWS EC2 host
- `76.76.21.241`, `66.33.60.129`, `64.239.109.1`, `64.239.123.1` -> anycast/cloud infrastructure, not the dominant traffic source in the measured sample

## Important Correction to the Initial Interpretation

Early in the investigation, the visible session in the pane suggested the bandwidth might be tied to older KindleFetch document exploration. That was only partially correct.

The more complete DB evidence later showed:

- the pane was attached to old `koreader` work
- but the heavy traffic window on `2026-03-09 20:08-20:13 EDT` came from later background subagent activity still writing new messages into old sessions
- those later messages were using `providerID = "opencode"`

So the correct explanation is:

- not "the shell was idle and telemetry suddenly started"
- but "an old OpenCode session still had live background subagents or retries running, and they were using OpenCode-hosted models"

## Why the Shell Looked Idle

The `tmux` pane capture showed no fresh terminal output after the last visible `opencode -s ...` resume command. However, OpenCode stores and updates session state in its local DB and log files independently of whether the shell prompt visibly changes.

This means a pane can appear idle while:

- background subagents continue to run
- pending tasks wake up
- model retries occur
- message objects get appended in the DB
- provider requests continue in the background

In short: visually idle did not mean process-idle.

## DB Evidence

### DB path

```text
/root/.local/share/opencode/opencode.db
```

### Relevant tables

Schema inspection showed these tables are the key ones for session forensics:

- `session`
- `message`
- `part`
- `project`

Meaning:

- `session`: one OpenCode session or subagent instance
- `message`: higher-level user/assistant messages for a session
- `part`: message components such as text, tool calls, step boundaries
- `project`: project/worktree metadata

### Session pointers that matter

Older visible pane session family:

- parent session: `ses_33417fadbfferdcfVWWuGsMH7P`
- title: `Codebase agents setup guide`
- directory: `/root/projects/koreader`

Earlier KindleFetch doc search subagent:

- `ses_32d6e8c40ffewF7wRWyP1rQ1HI`
- title: `Find KindleFetch-specific existing docs and unresolved issues (@explore subagent)`

Sessions that were still receiving new messages around the slowdown window:

- `ses_32d2c8848ffeoHGhKE8GexfStA`
- `ses_32d297be6ffeL4bV3f6t6BdI0u`
- `ses_32d322bfcffem8PXyVgCVeeR39`
- `ses_32d297af9ffekSDQYMtqsABwO7`
- `ses_32d10ebebffeYggIo6i0Ae54GQ`
- `ses_32d297c99ffeq4L3f1Zn7nJlXm`

These were all related `koreader` subagents.

### What proved the sessions were active during the slowdown

Querying `message` and `part` showed fresh activity on `2026-03-09 20:08-20:13 EDT`.

Representative pattern from `part`:

```text
step-start
step-finish
step-start
step-finish
```

repeated every few minutes across multiple subagent sessions.

This matters because it shows the old `koreader` sessions were not dormant historical artifacts. They were being actively updated during the same general time window as the bandwidth spike.

### Provider and model proof

The most important DB evidence came from the `message.data` JSON for the later assistant messages.

Examples recovered:

```json
{
  "role": "assistant",
  "modelID": "minimax-m2.5-free",
  "providerID": "opencode",
  "mode": "explore",
  "agent": "explore"
}
```

and:

```json
{
  "role": "assistant",
  "modelID": "big-pickle",
  "providerID": "opencode",
  "mode": "explore",
  "agent": "explore"
}
```

Several of the newest messages in that window also ended with:

- `MessageAbortedError`

That suggests retry/abort behavior in addition to successful model requests.

### Why this matters

If the traffic had been just local bookkeeping or telemetry, I would not expect to see:

- fresh assistant messages
- fresh `step-start` and `step-finish` events
- explicit `providerID = "opencode"`
- explicit model IDs for hosted models

Those fields indicate actual model work was in progress.

## Reconstructing the Workload

### Earlier daytime work

The original visible subagent `ses_32d6e8c40ffewF7wRWyP1rQ1HI` was short and exploratory. It used only local read/search tools against the `koreader` tree, for example:

- `read`
- `grep`
- `glob`
- a small amount of local `bash`

Files read included:

- `/root/projects/koreader/plugins/kindlefetch.koplugin/main.lua`
- `/root/projects/koreader/plugins/kindlefetch.koplugin/browser.lua`
- `/root/projects/koreader/KINDLEFETCH_PROGRESS_BAR_HANDOFF.md`
- `/root/projects/koreader/KINDLE_LEAN_UI_FINDINGS.md`
- `/root/projects/koreader/KINDLE_SCRIPTLETS_FINDINGS.md`

That earlier work explains why OpenCode had a large amount of repo context available to send to a hosted provider.

### Later evening work

The later subagent sessions that woke up around `20:08-20:13 EDT` were not all the same exact session ID as the one visible in the shell prompt. They were related descendants from the broader `koreader` session graph.

This is consistent with OpenCode continuing background exploration or retry behavior inside the same project/session family even when the pane showed no new text.

## Official OpenCode Policy Review

### What I found

OpenCode's public materials support the following:

1. The product markets itself as privacy-first.
2. OpenCode can run through direct provider APIs or through OpenCode-hosted provider/gateway paths.
3. The hosted service paths clearly involve sending prompts/content to their infrastructure.
4. The website and hosted services have analytics/privacy/terms language.
5. I did not find a clear standalone CLI telemetry policy that explains large background uploads while a session appears idle.

### Specific policy conclusions

From the public docs and legal pages:

- The homepage and enterprise docs say OpenCode does not store code/context data in the normal privacy-first path, with `/share` as a stated exception.
- The providers docs and Zen docs show that `opencode.ai` can serve as a provider/gateway.
- The privacy policy says hosted services may collect device/IP/usage data and also information included in prompts/conversations submitted to AI.
- The terms say unpaid accounts may permit content use to improve the services.
- The repo security policy says provider data handling is out of scope and governed by provider policy.

### Expected vs unexpected behavior

Expected:

- if configured to use OpenCode-hosted providers, OpenCode will send prompt/context data to `opencode.ai`

Not clearly documented, or at least not obvious from the user experience:

- that an apparently idle shell may still have background subagents actively sending inference traffic long after visible interaction appears to have stopped

## Most Likely Explanation

The most likely explanation for the slowdown is:

1. an old OpenCode `koreader` session remained alive in `tmux`
2. its subagent graph was still active or retrying
3. those subagents were using `providerID = "opencode"`
4. the process transmitted accumulated repo/context data to OpenCode-hosted model endpoints
5. this created sustained outbound bandwidth usage that was noticeable at the network level but not obvious in the pane UI

## Confidence Assessment

High confidence:

- `opencode` was the top bandwidth consumer
- the hottest connections were to `opencode.ai`
- the relevant DB sessions were still active during the slowdown window
- the active messages were hosted-provider model calls, not just local state changes

Moderate confidence:

- the exact user-visible mechanism was background retry / subagent wake-up rather than a specific single "resume session" action typed by hand during the slowdown

Lower confidence:

- the exact payload contents of the HTTPS uploads, because packet payloads were not captured

## Commands and Queries Used

### Process and socket attribution

```bash
ss -tpn
ss -tinp
ps -fp <pid>
pwdx <pid>
lsof -Pan -p <pid> -iTCP -sTCP:ESTABLISHED
cat /proc/net/dev
```

### DB inspection

```bash
sqlite3 ~/.local/share/opencode/opencode.db ".tables"
sqlite3 ~/.local/share/opencode/opencode.db ".schema session"
sqlite3 ~/.local/share/opencode/opencode.db ".schema message"
sqlite3 ~/.local/share/opencode/opencode.db ".schema part"
```

Useful session query:

```sql
select id, title, directory, time_created, time_updated, parent_id
from session
order by time_updated desc
limit 25;
```

Useful message/provider query:

```sql
select
  session_id,
  id,
  substr(json_extract(data,'$.providerID'),1,20) as provider,
  substr(json_extract(data,'$.modelID'),1,40) as model,
  json_extract(data,'$.error.name') as error,
  time_created,
  time_updated
from message
where session_id in (
  'ses_32d2c8848ffeoHGhKE8GexfStA',
  'ses_32d297be6ffeL4bV3f6t6BdI0u',
  'ses_32d322bfcffem8PXyVgCVeeR39',
  'ses_32d297af9ffekSDQYMtqsABwO7',
  'ses_32d10ebebffeYggIo6i0Ae54GQ',
  'ses_32d297c99ffeq4L3f1Zn7nJlXm'
)
and time_created > 1773101200000
order by time_created desc;
```

Useful part query for timeline reconstruction:

```sql
select
  session_id,
  time_created,
  json_extract(data,'$.type') as type,
  substr(replace(replace(json_extract(data,'$.text'), char(10), ' '), char(13), ' '),1,260) as text
from part
where session_id = 'ses_32d2c8848ffeoHGhKE8GexfStA'
  and time_created > 1773101400000
order by time_created asc;
```

### Log review

```bash
ls -lt --full-time ~/.local/share/opencode/log
rg -n "providerID=opencode|sessionID=<session-id>|MessageAbortedError" ~/.local/share/opencode/log/*.log
```

### Pane and tmux context

```bash
tmux list-panes -a -F '#{session_name} #{window_index}.#{pane_index} #{pane_tty} #{pane_current_path} #{pane_current_command} #{pane_pid}'
tmux capture-pane -t 1:4.0 -p -S -400
```

## Additional Notes

I intentionally did not copy secrets from:

- `/root/.local/share/opencode/auth.json`

That file contains auth credentials and should be treated as sensitive.

Also, the DB and logs strongly support that OpenCode-hosted inference was happening, but they do not by themselves prove the exact plaintext body sent over HTTPS. They are sufficient, however, to explain the bandwidth event with high confidence.

## Recommended Next Steps

1. Kill or clean up stale OpenCode sessions that are no longer needed.
2. Disable `oh-my-opencode` if you do not want aggressive background subagents.
3. Reconfigure OpenCode away from the hosted `opencode` provider if you want all inference to go directly to a provider you control.
4. If this must never recur, add a live watcher for `ss -tinp` and OpenCode session writes so future spikes can be identified immediately.

## Final Conclusion

The bandwidth spike on `2026-03-09` is best explained by live background OpenCode inference activity from an old `koreader` session family, not by a shell doing nothing and not by ordinary telemetry alone.

The user-visible pane looked idle, but the local DB proves the OpenCode session graph was still generating hosted-provider assistant messages during the slowdown window, and the network sample shows that `opencode` was simultaneously pushing large amounts of outbound HTTPS traffic to `opencode.ai`.
