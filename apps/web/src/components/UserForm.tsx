interface Props {
  value: string;
  onChange: (value: string) => void;
  locked: boolean;
  busy: boolean;
  // Which button starts the line: none while in line or done, `rejoin` after the window ran out.
  joinAction: 'join' | 'rejoin' | null;
  canJoin: boolean;
  onJoin: () => void;
  onCheck: () => void;
}

export function UserForm(p: Props) {
  return (
    <section>
      <label htmlFor="user-id">Email or username</label>
      <input
        id="user-id"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        disabled={p.locked}
        autoComplete="username"
      />
      <div className="actions">
        {p.joinAction && (
          <button onClick={p.onJoin} disabled={p.busy || (p.joinAction === 'join' && !p.canJoin)}>
            {p.joinAction === 'join' ? 'Join line' : 'Rejoin'}
          </button>
        )}
        <button className="secondary" onClick={p.onCheck} disabled={p.busy}>
          Check my order
        </button>
      </div>
    </section>
  );
}
