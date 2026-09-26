import type { Migration } from './state-db.ts';

/**
 * natsumi-owned state in `.natsumi/state.sqlite`. The conversation shown to the owner lives here; the thinking loop's
 * own record (every event, thought and tool call) lives only in the Pi session JSONL (ADR 0008).
 * Append new migrations; never edit a released one. Approvals and other schedules are added
 * by the changes that implement them.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'conversations-and-operations',
    sql: `
      -- The app conversation and the Pi session it maps to. pi_session_file is relative to the Pi session directory.
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        pi_session_id TEXT NOT NULL UNIQUE,
        pi_session_file TEXT NOT NULL UNIQUE CHECK (
          pi_session_file <> '' AND substr(pi_session_file, 1, 1) <> '/'
          AND pi_session_file NOT LIKE '..%' AND pi_session_file NOT LIKE '%/..%'),
        created_at TEXT NOT NULL
      ) STRICT;

      -- conversation.send deduplication: request ID, sender, body hash (never the body) and progress.
      CREATE TABLE conversation_operations (
        request_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        body_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        pi_user_entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX conversation_operations_by_conversation ON conversation_operations (conversation_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'client-sessions',
    sql: `
      -- Short-lived client sessions issued after GitHub login. Only the SHA-256 of the bearer token is kept, never the token.
      CREATE TABLE client_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        github_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX client_sessions_by_expiry ON client_sessions (expires_at);
    `,
  },
  {
    version: 3,
    name: 'devices',
    sql: `
      -- Devices the server registered for the allowed GitHub account. A device ID names a client's event stream;
      -- it is never accepted as authentication.
      CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        client_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: 'thinking-loop',
    sql: `
      -- The per-turn send operations of the first design were never used; owner messages carry their request ID instead.
      DROP TABLE conversation_operations;

      -- What the owner sees: owner messages and what natsumi sent them through reply_to_mac and notify_owner.
      -- Thoughts, tool calls and other events stay in the Pi session, which is a different record (ADR 0008).
      CREATE TABLE conversation_messages (
        message_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'natsumi')),
        kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'notice')),
        text TEXT NOT NULL,
        -- An owner message: its event. A reply: the event it answers.
        event_id TEXT,
        -- A notice: the JSON array of events it is about, if any.
        about_event_ids TEXT,
        request_id TEXT UNIQUE,
        device_id TEXT,
        created_at TEXT NOT NULL,
        CHECK ((kind = 'message') = (role = 'owner')),
        CHECK (kind <> 'message' OR (event_id IS NOT NULL AND request_id IS NOT NULL AND device_id IS NOT NULL)),
        CHECK (kind <> 'reply' OR event_id IS NOT NULL)
      ) STRICT;
      -- One reply per event, even across restarts.
      CREATE UNIQUE INDEX conversation_messages_one_reply ON conversation_messages (event_id) WHERE kind = 'reply';

      -- Inputs of the thinking loop and how far each got.
      CREATE TABLE loop_events (
        event_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        message_id TEXT REFERENCES conversation_messages (message_id),
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'replied', 'no-reply', 'failed')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX loop_events_by_state ON loop_events (state, created_at);
    `,
  },
  {
    version: 5,
    name: 'session-rotations',
    sql: `
      -- Nightly switches of the thinking loop's Pi session (ADR 0009). The old session file is kept; conversations
      -- points to the new one only once the switch is committed. A 'switching' row carries a handoff written before
      -- a stop, and the next start finishes that switch.
      CREATE TABLE session_rotations (
        rotation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES loop_events (event_id),
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        from_session_id TEXT NOT NULL,
        from_session_file TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reviewing', 'switching', 'switched', 'failed')),
        -- What the review wrote for the next session. It goes into that session's instructions.
        handoff TEXT,
        to_session_id TEXT UNIQUE,
        to_session_file TEXT UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state NOT IN ('switching', 'switched') OR handoff IS NOT NULL),
        CHECK (state <> 'switched' OR (to_session_id IS NOT NULL AND to_session_file IS NOT NULL))
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: 'read-state',
    sql: `
      -- How far the owner has read natsumi's replies: one cursor for every device (ADR 0013). It only moves forward.
      CREATE TABLE read_cursor (
        owner INTEGER PRIMARY KEY CHECK (owner = 1),
        message_id TEXT NOT NULL REFERENCES conversation_messages (message_id),
        -- The device that last moved it.
        device_id TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Notices the owner has checked, one by one and apart from the cursor.
      CREATE TABLE notice_acknowledgements (
        message_id TEXT PRIMARY KEY REFERENCES conversation_messages (message_id),
        device_id TEXT,
        acknowledged_at TEXT NOT NULL
      ) STRICT;

      -- What already exists counts as read and checked, so an upgrade does not bring back old words as unread.
      INSERT INTO read_cursor (owner, message_id, device_id, updated_at)
        SELECT 1, message_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM conversation_messages ORDER BY position DESC LIMIT 1;
      INSERT INTO notice_acknowledgements (message_id, device_id, acknowledged_at)
        SELECT message_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM conversation_messages WHERE kind = 'notice';
    `,
  },
  {
    version: 7,
    name: 'self-checks',
    sql: `
      -- Checks natsumi booked for herself (ADR 0014). due_at is the absolute time the server resolved the booking to.
      -- A delivered check names the event that carried it; a cancelled one stays so it still counts for its day.
      CREATE TABLE self_checks (
        check_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        -- The reason normalized, to fold the same reason into one pending booking.
        reason_key TEXT NOT NULL,
        due_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'cancelled')),
        event_id TEXT REFERENCES loop_events (event_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'delivered') = (event_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX self_checks_by_due ON self_checks (state, due_at);
      CREATE INDEX self_checks_by_creation ON self_checks (created_at);
      CREATE UNIQUE INDEX self_checks_one_pending_reason ON self_checks (reason_key) WHERE state = 'pending';
    `,
  },
  {
    version: 8,
    name: 'handoff-in-the-repository',
    sql: `
      -- The handoff moves to handoff.md in the memory repository, which is now the only place it is written and the
      -- only place a new session's instructions read it from (ADR 0020). What stays here is which commit of that file
      -- a switch started its session with, so the history can be followed back without holding the text twice.
      --
      -- The only copy of the handoff is about to go, so the newest one is set aside first: the start that follows
      -- this upgrade writes it into handoff.md and empties this table, and nothing ever fills it again.
      CREATE TABLE handoff_carryover (
        carryover INTEGER PRIMARY KEY CHECK (carryover = 1),
        handoff TEXT NOT NULL
      ) STRICT;
      INSERT INTO handoff_carryover (carryover, handoff)
        SELECT 1, handoff FROM session_rotations WHERE handoff IS NOT NULL
        ORDER BY updated_at DESC, rotation_id DESC LIMIT 1;

      -- SQLite drops a column by rebuilding the table. The invariant "a finished switch names a handoff commit" is
      -- deliberately not a CHECK: the switches already recorded were made before the file existed, their commit is
      -- NULL, and a table CHECK would reach back over them and fail this migration. NULL says truthfully that there
      -- was no file then. The code and its tests hold the invariant for the rows written from now on.
      CREATE TABLE session_rotations_new (
        rotation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES loop_events (event_id),
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        from_session_id TEXT NOT NULL,
        from_session_file TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reviewing', 'switching', 'switched', 'failed')),
        -- The commit of handoff.md the new session's instructions were built from. NULL on the rows made before
        -- the file existed, and on a switch that has not written its handoff yet.
        handoff_commit TEXT,
        to_session_id TEXT UNIQUE,
        to_session_file TEXT UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state <> 'switched' OR (to_session_id IS NOT NULL AND to_session_file IS NOT NULL))
      ) STRICT;
      INSERT INTO session_rotations_new (rotation_id, event_id, conversation_id, from_session_id, from_session_file,
        state, handoff_commit, to_session_id, to_session_file, reason, created_at, updated_at)
        SELECT rotation_id, event_id, conversation_id, from_session_id, from_session_file,
          state, NULL, to_session_id, to_session_file, reason, created_at, updated_at FROM session_rotations;
      DROP TABLE session_rotations;
      ALTER TABLE session_rotations_new RENAME TO session_rotations;
    `,
  },
  {
    version: 9,
    name: 'line-expression',
    sql: `
      -- The feeling natsumi chose for each of her lines, from the avatar expressions (ADR 0026). It is not the avatar's
      -- expression and never moves it. Only her lines carry one. The lines written before this have none and are not
      -- filled in: NULL reads as "not known", not as neutral.
      --
      -- Which values are allowed is kept by the tool and the server, not by a CHECK: the list grows with the avatar's
      -- expressions, and a CHECK here would make every such change a rebuild of this table.
      ALTER TABLE conversation_messages ADD COLUMN expression TEXT CHECK (expression IS NULL OR kind <> 'message');
    `,
  },
  {
    version: 10,
    name: 'push-registrations',
    sql: `
      -- Where to push a device that is not connected (ADR 0029): its APNs device token, the public key its pushes are
      -- encrypted to, and which APNs it belongs to. One per device, overwritten on every push.register; a token
      -- belongs to one device at a time. Only the public key is here: the device keeps its private key.
      -- Whether a device may still be sent to is not kept here: it follows the session the device last synced with.
      CREATE TABLE push_registrations (
        device_id TEXT PRIMARY KEY REFERENCES devices (device_id),
        token TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL CHECK (length(public_key) = 65),
        environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 11,
    name: 'replies-without-an-event',
    // The table is made anew, and loop_events, read_cursor and notice_acknowledgements point at it.
    foreignKeysOff: true,
    sql: `
      -- natsumi may speak to the owner as often as she has something to say, also when no owner message waits for an
      -- answer (ADR 0032). The reply that answers waiting messages still names the newest of them, and there is still
      -- at most one such reply per event: that is what keeps a message from being answered twice across a restart.
      -- Every other reply names no event. SQLite drops the CHECK that required one only by rebuilding the table; the
      -- rest of it, and every row, stays as it was.
      CREATE TABLE conversation_messages_new (
        message_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'natsumi')),
        kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'notice')),
        text TEXT NOT NULL,
        -- An owner message: its event. A reply: the event of the newest message it answered, if it answered any.
        event_id TEXT,
        -- A notice: the JSON array of events it is about, if any.
        about_event_ids TEXT,
        request_id TEXT UNIQUE,
        device_id TEXT,
        created_at TEXT NOT NULL,
        expression TEXT CHECK (expression IS NULL OR kind <> 'message'),
        CHECK ((kind = 'message') = (role = 'owner')),
        CHECK (kind <> 'message' OR (event_id IS NOT NULL AND request_id IS NOT NULL AND device_id IS NOT NULL))
      ) STRICT;
      INSERT INTO conversation_messages_new (message_id, position, role, kind, text, event_id, about_event_ids,
        request_id, device_id, created_at, expression)
        SELECT message_id, position, role, kind, text, event_id, about_event_ids,
          request_id, device_id, created_at, expression FROM conversation_messages;
      DROP TABLE conversation_messages;
      ALTER TABLE conversation_messages_new RENAME TO conversation_messages;
      -- One reply that answers an event, even across restarts. The replies that answer none are not in the index.
      CREATE UNIQUE INDEX conversation_messages_one_reply ON conversation_messages (event_id) WHERE kind = 'reply';
    `,
  },
  {
    version: 12,
    name: 'outside-agents',
    sql: `
      -- The latest exchange with each outside agent (ADR 0035). ask_agent with continue goes on with it, so natsumi
      -- never sees or copies its ID. task_id is the task last sent in it: continue answers it when it asked a
      -- question, and waits while it runs. An agent that answered with a message alone leaves no task.
      CREATE TABLE agent_contexts (
        agent TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        task_id TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Tasks natsumi started, and how far each got. A waiting task is fetched until it settles or the wait runs out;
      -- one asking a question waits for her answer and is not fetched. sent_at is the last message sent to it: the
      -- wait limit counts from there (ADR 0036). A restart fetches the waiting ones again.
      CREATE TABLE agent_tasks (
        agent TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'input-required', 'completed', 'failed', 'gave-up')),
        sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent, task_id)
      ) STRICT;
      CREATE INDEX agent_tasks_by_state ON agent_tasks (state, sent_at);

      -- What an agent answered, as the agent-reply event that carries it. It is natsumi's to read and never part of
      -- the conversation shown to the owner (ADR 0025).
      CREATE TABLE agent_replies (
        event_id TEXT PRIMARY KEY REFERENCES loop_events (event_id),
        agent TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'input-required', 'gave-up')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 13,
    name: 'slack',
    sql: `
      -- The channels and DMs of each Slack workspace the bot is in (ADR 0039). directory is where their files go under
      -- sources/slack/<workspace>/, fixed the first time the channel is seen, so a rename never moves the files natsumi
      -- has been reading. label is how she names it: #dev, or @name for a DM.
      CREATE TABLE slack_channels (
        workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        label TEXT NOT NULL,
        is_im INTEGER NOT NULL CHECK (is_im IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace, channel_id),
        UNIQUE (workspace, directory)
      ) STRICT;

      -- Every message recorded, which the day files are written from. A deleted one is kept as deleted: its replies
      -- still stand under it. file_date is the local date of the file it is written in: its own, or its parent's.
      -- counted is 1 while it waits to be shown in the updates of a ping or a self-check, and 0 once shown or never
      -- to be counted (her own posts, the parents fetched for an old thread, what a mention event already showed).
      CREATE TABLE slack_messages (
        workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        thread_ts TEXT,
        speaker TEXT NOT NULL,
        own INTEGER NOT NULL CHECK (own IN (0, 1)),
        text TEXT NOT NULL,
        -- JSON: [{ "name", "path"? }], path being where the workspace sees a fetched image.
        files TEXT NOT NULL,
        edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        file_date TEXT NOT NULL,
        counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace, channel_id, ts),
        FOREIGN KEY (workspace, channel_id) REFERENCES slack_channels (workspace, channel_id)
      ) STRICT;
      CREATE INDEX slack_messages_by_file ON slack_messages (workspace, channel_id, file_date);
      CREATE INDEX slack_messages_counted ON slack_messages (counted) WHERE counted = 1;

      -- The mentions and DMs that became events. One message makes one event, however often Slack sends it.
      CREATE TABLE slack_mentions (
        event_id TEXT PRIMARY KEY REFERENCES loop_events (event_id),
        workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        UNIQUE (workspace, channel_id, ts)
      ) STRICT;
    `,
  },
  {
    version: 14,
    name: 'dove-and-approvals',
    sql: `
      -- What natsumi asked the dove to post or react with (ADR 0040), and what became of it. The target is the message
      -- she named (target_ts, and target_thread_ts when it is a reply), or the channel itself when target_ts is NULL;
      -- reference is how she named it, which is all her events ever show. verdict, scores (JSON: name, label, score,
      -- flagged per issue) and placement_probabilities are Jev's, kept to look back on how it judged (ADR 0039).
      -- placement is where the post was to go: Jev's choice, or the server's rule without one.
      CREATE TABLE dove_posts (
        post_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('post', 'reaction')),
        workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        target_ts TEXT,
        target_thread_ts TEXT,
        reference TEXT NOT NULL,
        text TEXT NOT NULL,
        expression TEXT,
        verdict TEXT CHECK (verdict IS NULL OR verdict IN ('send', 'owner', 'return', 'no-verdict', 'rewrite-limit')),
        scores TEXT,
        placement_probabilities TEXT,
        placement TEXT CHECK (placement IS NULL OR placement IN ('thread', 'channel')),
        state TEXT NOT NULL CHECK (state IN ('judging', 'sending', 'sent', 'returned', 'pending', 'rejected', 'expired', 'failed')),
        -- What was sent and where: the draft, or the owner's own text when she edited it.
        sent_text TEXT,
        sent_placement TEXT,
        failure TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX dove_posts_by_target ON dove_posts (workspace, channel_id, target_ts, created_at);
      CREATE INDEX dove_posts_by_state ON dove_posts (state);

      -- What waits for the owner's decision (ADR 0002, ADR 0040). payload is the approval as the devices are shown it,
      -- fixed when it is made: what she approves is what was shown to her. The decision, the owner's own text and
      -- placement when she edited, and what the send came to are kept beside it, so the owner's judgement can be
      -- set against Jev's.
      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('slack-post')),
        post_id TEXT NOT NULL UNIQUE REFERENCES dove_posts (post_id),
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'edited', 'rejected', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'edit', 'reject')),
        decided_text TEXT,
        decided_placement TEXT,
        device_id TEXT,
        delivery TEXT CHECK (delivery IS NULL OR delivery IN ('sent', 'failed')),
        delivery_reason TEXT,
        sent_text TEXT,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX approvals_by_state ON approvals (state, expires_at);

      -- The dove's answers, as the events that carry them to natsumi. The text is the server's, and is emptied once
      -- handed over: from then on it is in the Pi session (ADR 0008).
      CREATE TABLE dove_replies (
        event_id TEXT PRIMARY KEY REFERENCES loop_events (event_id),
        post_id TEXT NOT NULL REFERENCES dove_posts (post_id),
        result TEXT NOT NULL CHECK (result IN ('sent', 'reacted', 'to_owner', 'returned', 'rejected', 'expired', 'not_sent')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 15,
    name: 'slack-reactions',
    sql: `
      -- The reactions on the messages recorded (ADR 0043), which the day files write under each message. user_id is
      -- who put it on, kept so that taking it off finds it, and never written where natsumi reads; reactor is their
      -- name as it was looked up. The row whose user_id is '' stands for those Slack only counted when it did not name
      -- everyone (a fill-in of a much-used reaction): others is how many they are. counted is 1 while a reaction someone
      -- else put on her own post waits to be shown in the updates, and 0 once shown or never to be counted. position
      -- orders the reactions on a message as Slack does: a reaction keeps its place while anyone still has it on.
      CREATE TABLE slack_reactions (
        workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        reactor TEXT NOT NULL,
        others INTEGER NOT NULL CHECK (others >= 0),
        counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace, channel_id, ts, name, user_id),
        FOREIGN KEY (workspace, channel_id, ts) REFERENCES slack_messages (workspace, channel_id, ts)
      ) STRICT;
      CREATE INDEX slack_reactions_counted ON slack_reactions (counted) WHERE counted = 1;
    `,
  },
  {
    version: 16,
    name: 'images',
    sql: `
      -- Images natsumi handed the server from /work (ADR 0044). source is the path as she wrote it; file is the copy the
      -- server took at that moment, in its own image directory, and the copy is what the owner is shown and what is
      -- sent. An image belongs to no one feature: the devices fetch it by its ID with the session.
      CREATE TABLE images (
        image_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        file TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      -- The images of a dove's post, in the order she named them. Kept with the post for looking back, like its text
      -- (ADR 0040).
      CREATE TABLE dove_post_images (
        post_id TEXT NOT NULL REFERENCES dove_posts (post_id),
        position INTEGER NOT NULL CHECK (position >= 0),
        image_id TEXT NOT NULL REFERENCES images (image_id),
        PRIMARY KEY (post_id, position)
      ) STRICT;
    `,
  },
  {
    version: 17,
    name: 'reply images',
    sql: `
      -- The size in pixels when the image's header says it (ADR 0045), for the devices to lay it out before it arrives.
      -- NULL on the images taken before, and on any whose header does not say.
      ALTER TABLE images ADD COLUMN width INTEGER CHECK (width > 0);
      ALTER TABLE images ADD COLUMN height INTEGER CHECK (height > 0);

      -- The images natsumi showed the owner with a reply, in the order she named them (ADR 0045). Kept with the line, as
      -- the conversation is, and never removed.
      CREATE TABLE conversation_message_images (
        message_id TEXT NOT NULL REFERENCES conversation_messages (message_id),
        position INTEGER NOT NULL CHECK (position >= 0),
        image_id TEXT NOT NULL REFERENCES images (image_id),
        PRIMARY KEY (message_id, position)
      ) STRICT;
      CREATE INDEX conversation_message_images_image ON conversation_message_images (image_id);
    `,
  },
  {
    version: 18,
    name: 'turn stats',
    sql: `
      -- One row of numbers per ordinary turn, to compare turns folded and not (ADR 0047). Nothing anyone said is here:
      -- the kinds of the events, the route's name, times in milliseconds and Pi's token counts. first_out_ms runs from
      -- the earliest event of the turn to her first reply_to_mac or request to the dove, NULL when there was none; the
      -- reflection columns are NULL when no memo was asked for. The tokens are summed over the turn's model calls;
      -- context_tokens is what its first call was sent. The last four count signs of her losing her way: run_shell
      -- commands and read paths she had already used in the session's context, tool results that were errors, requests
      -- the dove turned back, and owner messages the turn was shown and ended without answering.
      CREATE TABLE turn_stats (
        turn_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        fold TEXT NOT NULL CHECK (fold IN ('on', 'off')),
        route TEXT NOT NULL,
        event_kinds TEXT NOT NULL,
        outcome TEXT NOT NULL,
        first_out_ms INTEGER CHECK (first_out_ms >= 0),
        turn_ms INTEGER NOT NULL CHECK (turn_ms >= 0),
        model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        context_tokens INTEGER CHECK (context_tokens >= 0),
        reflection_ms INTEGER CHECK (reflection_ms >= 0),
        reflection_input_tokens INTEGER CHECK (reflection_input_tokens >= 0),
        reflection_cache_read_tokens INTEGER CHECK (reflection_cache_read_tokens >= 0),
        reflection_output_tokens INTEGER CHECK (reflection_output_tokens >= 0),
        compacted INTEGER NOT NULL CHECK (compacted IN (0, 1)),
        repeated_calls INTEGER NOT NULL CHECK (repeated_calls >= 0),
        tool_errors INTEGER NOT NULL CHECK (tool_errors >= 0),
        dove_refusals INTEGER NOT NULL CHECK (dove_refusals >= 0),
        unanswered_messages INTEGER NOT NULL CHECK (unanswered_messages >= 0)
      ) STRICT;
      CREATE INDEX turn_stats_started ON turn_stats (started_at);
    `,
  },
];
