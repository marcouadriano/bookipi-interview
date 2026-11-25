export interface Product {
  name: string;
  price: string;
}

// There is no product API yet: the sale is of one item.
export const PRODUCT: Product = { name: 'Flash Sale Item', price: '$49.00' };
