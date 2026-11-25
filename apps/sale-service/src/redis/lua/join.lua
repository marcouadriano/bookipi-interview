-- KEYS: ready, stock, buyers, tickets, pops, last, serving
-- ARGV: user, saleStart, saleEnd, window
-- Returns {'unavailable'} | {'purchased'} | {'inactive'} | {state, ticket, serving, windowEnd}
local ready_key, stock_key, buyers_key, tickets_key, pops_key, last_key, serving_key =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]
local user = ARGV[1]
local sale_start, sale_end, window_ms = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])

if not is_ready(ready_key) then return {'unavailable'} end
if redis.call('SISMEMBER', buyers_key, user) == 1 then return {'purchased'} end

local now = now_ms()
if not in_window(now, sale_start, sale_end) or not has_stock(stock_key) then return {'inactive'} end

local serving = tonumber(redis.call('GET', serving_key)) or 0
local state, window_end = admission(tickets_key, pops_key, user, now, window_ms)
if state == 'waiting' or state == 'admitted' then
  -- joining again keeps the same place
  return {state, tonumber(redis.call('HGET', tickets_key, user)), serving, window_end}
end

-- new user, or the window ran out: back of the line
local ticket = redis.call('INCR', last_key)
redis.call('HSET', tickets_key, user, ticket)
return {'waiting', ticket, serving, 0}
