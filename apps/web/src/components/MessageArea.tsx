import type { Message } from '../messages';

export function MessageArea({ message }: { message: Message | null }) {
  return (
    <p className={`message ${message?.tone ?? ''}`} aria-live="polite">
      {message?.text}
    </p>
  );
}
