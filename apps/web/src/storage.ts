const USER_ID_KEY = 'flashSale.userId';

// localStorage can throw (private browsing), so every access is wrapped.
export function readSavedUserId(): string {
  try {
    return localStorage.getItem(USER_ID_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveUserId(id: string): void {
  try {
    localStorage.setItem(USER_ID_KEY, id);
  } catch {
    // the ID just isn't remembered
  }
}
