-- Shared helpers, placed in front of every script.

-- Redis's own clock, in milliseconds.
local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

-- True once the sale has been filled from Postgres.
local function is_ready(ready_key)
  return redis.call('EXISTS', ready_key) == 1
end

-- True while `now` is inside the sale window, both ends included.
local function in_window(now, sale_start, sale_end)
  return now >= tonumber(sale_start) and now <= tonumber(sale_end)
end

local function has_stock(stock_key)
  return (tonumber(redis.call('GET', stock_key)) or 0) > 0
end

-- 'none' | 'waiting' | 'admitted' | 'expired', plus the end of the buying window (ms).
-- A user's pop is the first pop whose `serving` reached their ticket.
local function admission(tickets, pops, user, now, window)
  local ticket = redis.call('HGET', tickets, user)
  if not ticket then return 'none', 0 end
  local pop = redis.call('ZRANGEBYSCORE', pops, tonumber(ticket), '+inf', 'LIMIT', 0, 1)
  if #pop == 0 then return 'waiting', 0 end
  local window_end = tonumber(pop[1]) + window
  if now >= window_end then return 'expired', window_end end
  return 'admitted', window_end
end
