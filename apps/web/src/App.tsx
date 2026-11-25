import { MessageArea } from './components/MessageArea';
import { StatusCard } from './components/StatusCard';
import { UserForm } from './components/UserForm';
import { WaitingPanel } from './components/WaitingPanel';
import { YourTurnPanel } from './components/YourTurnPanel';
import { useFlashSale } from './hooks/useFlashSale';
import { PRODUCT } from './product';

export function App() {
  const s = useFlashSale();

  return (
    <main>
      <h1>Flash Sale</h1>
      <StatusCard status={s.saleStatus} countdown={s.countdown} />

      {s.pageState === 'waiting' && <WaitingPanel />}
      {s.pageState === 'admitted' && (
        <YourTurnPanel product={PRODUCT} timeLeft={s.windowLeft} busy={s.busy} onBuy={s.buyNow} />
      )}

      {s.pageState !== 'loading' && (
        <UserForm
          value={s.input}
          onChange={s.setInput}
          locked={s.idLocked}
          busy={s.busy}
          joinAction={
            s.pageState === 'ready' ? 'join' : s.pageState === 'expired' ? 'rejoin' : null
          }
          canJoin={s.canJoin}
          onJoin={s.join}
          onCheck={s.checkOrder}
        />
      )}

      <MessageArea message={s.message} />
    </main>
  );
}
