import type { Product } from '../product';

interface Props {
  product: Product;
  timeLeft: string;
  busy: boolean;
  onBuy: () => void;
}

export function YourTurnPanel({ product, timeLeft, busy, onBuy }: Props) {
  return (
    <section>
      <div className="product">
        <div className="image" role="img" aria-label="Product image placeholder" />
        <div>
          <strong>{product.name}</strong>
          <p>{product.price}</p>
        </div>
      </div>
      <p>You have {timeLeft} to complete your purchase.</p>
      <div className="actions">
        <button onClick={onBuy} disabled={busy}>
          Buy Now
        </button>
      </div>
    </section>
  );
}
