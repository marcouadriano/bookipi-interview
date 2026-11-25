-- KEYS: ready, stock, buyers, tickets, pops, purchases, ordersStream
-- ARGV: user, saleId, saleStart, saleEnd, window
-- Checks in order, stops at the first that fails.
-- Returns {'unavailable'} | {'not_active', 'upcoming'|'ended'} | {'already_purchased'}
--       | {'not_admitted'} | {'sold_out'} | {'accepted'}
local ready_key, stock_key, buyers_key, tickets_key, pops_key, purchases_key, orders_key =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]
local user, sale_id = ARGV[1], ARGV[2]
local sale_start, sale_end, window_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])

if not is_ready(ready_key) then return {'unavailable'} end

local now = now_ms()
if now < sale_start then return {'not_active', 'upcoming'} end
if now > sale_end then return {'not_active', 'ended'} end

if redis.call('SISMEMBER', buyers_key, user) == 1 then return {'already_purchased'} end

local state = admission(tickets_key, pops_key, user, now, window_ms)
if state ~= 'admitted' then return {'not_admitted'} end

if not has_stock(stock_key) then return {'sold_out'} end

-- all checks passed: take the unit, mark the buyer, queue the order, in the same step
redis.call('DECR', stock_key)
redis.call('SADD', buyers_key, user)
redis.call('HSET', purchases_key, user, 'processing')
redis.call('XADD', orders_key, '*', 'saleId', sale_id, 'userId', user, 'reservedAtMs', string.format('%.0f', now))
return {'accepted'}
