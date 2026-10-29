use near_sdk::{
    borsh::{BorshDeserialize, BorshSerialize},
    env, near, serde::{Deserialize, Serialize}, serde_json,
    json_types::{U128, U64}, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
};
use std::collections::{BTreeMap, VecDeque};

const DAY_NS: u64 = 86_400_000_000_000;
const MAX_AGENTS: usize = 32;
const MAX_PENDING: usize = 64;
const MAX_TRANSFERS: usize = 64;
const MAX_AUDIT: usize = 128;
const MAX_MEMO: usize = 256;
const CALLBACK_GAS: Gas = Gas::from_tgas(15);

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Policy {
    pub per_tx_max: U128,
    pub daily_max: U128,
    pub allowlist: Vec<AccountId>,
    pub approval_threshold: U128,
    pub paused: bool,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct Agent {
    policy: Policy,
    generation: u64,
    day: u64,
    spent: u128,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Request {
    pub id: U64,
    pub agent: AccountId,
    pub receiver: AccountId,
    pub amount: U128,
    pub memo: String,
    pub created_at: U64,
    pub expires_at: U64,
    generation: U64,
    day: U64,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct Transfer {
    agent: AccountId,
    generation: u64,
    day: u64,
    amount: u128,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Audit {
    pub id: U64,
    pub timestamp: U64,
    pub event: String,
    pub data: BTreeMap<String, String>,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde", tag = "status", rename_all = "snake_case")]
pub enum SpendResult {
    Transferring { transfer_id: U64 },
    Pending { request_id: U64 },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SpendGuard {
    owner: AccountId,
    paused: bool,
    agents: BTreeMap<AccountId, Agent>,
    pending: BTreeMap<u64, Request>,
    transfers: BTreeMap<u64, Transfer>,
    reserved: u128,
    next_id: u64,
    audit: VecDeque<Audit>,
    next_event: u64,
}

#[near]
impl SpendGuard {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert_eq!(env::predecessor_account_id(), owner, "E_OWNER");
        assert_ne!(owner, env::current_account_id(), "E_OWNER_IS_CONTRACT");
        Self {
            owner, paused: false, agents: BTreeMap::new(), pending: BTreeMap::new(),
            transfers: BTreeMap::new(), reserved: 0, next_id: 0,
            audit: VecDeque::new(), next_event: 0,
        }
    }

    pub fn add_agent(&mut self, agent: AccountId, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        assert_ne!(agent, self.owner, "E_OWNER_IS_AGENT");
        assert_ne!(agent, env::current_account_id(), "E_CONTRACT_IS_AGENT");
        assert!(!self.agents.contains_key(&agent), "E_AGENT_EXISTS");
        assert!(self.agents.len() < MAX_AGENTS, "E_AGENT_LIMIT");
        let generation = self.allocate_id();
        self.agents.insert(agent.clone(), Agent { policy, generation, day: Self::day(), spent: 0 });
        self.record("agent_added", [("agent", agent.to_string())]);
    }

    pub fn update_policy(&mut self, agent: AccountId, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        self.agents.get_mut(&agent).expect("E_NOT_AGENT").policy = policy;
        self.record("policy_updated", [("agent", agent.to_string())]);
    }

    pub fn remove_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        assert!(self.agents.contains_key(&agent), "E_NOT_AGENT");
        let ids: Vec<_> = self.pending.values().filter(|r| r.agent == agent).map(|r| r.id.0).collect();
        for id in ids { self.release_request(id, "cancelled"); }
        self.agents.remove(&agent);
        self.record("agent_removed", [("agent", agent.to_string())]);
    }

    pub fn pause(&mut self) { self.assert_owner(); self.paused = true; self.record("paused", []); }
    pub fn unpause(&mut self) { self.assert_owner(); self.paused = false; self.record("unpaused", []); }
    pub fn pause_agent(&mut self, agent: AccountId) { self.set_agent_pause(agent, true); }
    pub fn unpause_agent(&mut self, agent: AccountId) { self.set_agent_pause(agent, false); }

    pub fn spend(&mut self, receiver: AccountId, amount: U128, memo: String) -> SpendResult {
        let agent = env::predecessor_account_id();
        // Direct calls only: the intended credential is a function-call key on the agent account.
        assert_eq!(agent, env::signer_account_id(), "E_NOT_AGENT");
        assert!(memo.len() <= MAX_MEMO, "E_MEMO");
        self.sweep_expired();
        self.validate_spend(&agent, &receiver, amount.0, false);
        self.ensure_liquid(amount.0);
        let state = self.agents.get(&agent).expect("E_NOT_AGENT");
        let pending = amount.0 > state.policy.approval_threshold.0;
        if pending { assert!(self.pending.len() < MAX_PENDING, "E_PENDING_LIMIT"); }
        else { assert!(self.transfers.len() < MAX_TRANSFERS, "E_TRANSFER_LIMIT"); }
        let generation = state.generation;
        let day = Self::day();
        let state = self.agents.get_mut(&agent).unwrap();
        if state.day != day { state.day = day; state.spent = 0; }
        state.spent = state.spent.checked_add(amount.0).expect("E_OVERFLOW");
        let id = self.allocate_id();
        self.record("spend_requested", [
            ("id", id.to_string()), ("agent", agent.to_string()),
            ("receiver", receiver.to_string()), ("amount", amount.0.to_string()), ("memo", memo.clone()),
        ]);
        if pending {
            self.reserved = self.reserved.checked_add(amount.0).expect("E_OVERFLOW");
            self.pending.insert(id, Request {
                id: U64(id), agent, receiver, amount, memo,
                created_at: U64(env::block_timestamp()), expires_at: U64((day + 1) * DAY_NS),
                generation: U64(generation), day: U64(day),
            });
            self.record("pending", [("request_id", id.to_string())]);
            SpendResult::Pending { request_id: U64(id) }
        } else {
            self.transfer(id, agent, receiver, amount.0, generation, day);
            SpendResult::Transferring { transfer_id: U64(id) }
        }
    }

    pub fn approve(&mut self, request_id: U64) -> U64 {
        self.assert_owner();
        let r = self.pending.get(&request_id.0).expect("E_REQUEST").clone();
        assert!(env::block_timestamp() < r.expires_at.0, "E_EXPIRED");
        assert_eq!(self.agents.get(&r.agent).expect("E_NOT_AGENT").generation, r.generation.0, "E_STALE");
        // Policy changes take effect on outstanding requests; their amount is already reserved.
        self.validate_spend(&r.agent, &r.receiver, r.amount.0, true);
        assert!(self.transfers.len() < MAX_TRANSFERS, "E_TRANSFER_LIMIT");
        self.ensure_liquid(0);
        self.pending.remove(&request_id.0);
        self.reserved -= r.amount.0;
        self.record("approved", [("request_id", request_id.0.to_string())]);
        self.transfer(r.id.0, r.agent, r.receiver, r.amount.0, r.generation.0, r.day.0);
        request_id
    }

    pub fn reject(&mut self, request_id: U64) {
        self.assert_owner();
        self.release_request(request_id.0, "rejected");
    }

    /// Anyone may release an expired reservation, including while paused.
    pub fn expire(&mut self, request_id: U64) {
        let r = self.pending.get(&request_id.0).expect("E_REQUEST");
        assert!(env::block_timestamp() >= r.expires_at.0, "E_NOT_EXPIRED");
        self.release_request(request_id.0, "expired");
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        assert!(amount.0 > 0, "E_AMOUNT");
        self.sweep_expired();
        self.ensure_liquid(amount.0);
        self.record("withdraw_requested", [("amount", amount.0.to_string())]);
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    #[private]
    pub fn on_transfer(&mut self, transfer_id: U64) -> bool {
        // Explicit check also protects direct Rust calls in unit tests.
        assert_eq!(env::predecessor_account_id(), env::current_account_id(), "E_PRIVATE");
        assert_eq!(env::promise_results_count(), 1, "E_CALLBACK");
        let t = self.transfers.remove(&transfer_id.0).expect("E_TRANSFER");
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !success { self.rollback(&t.agent, t.generation, t.day, t.amount); }
        self.record(if success { "transfer_succeeded" } else { "transfer_failed" }, [
            ("transfer_id", transfer_id.0.to_string()), ("agent", t.agent.to_string()),
            ("amount", t.amount.to_string()),
        ]);
        success
    }

    pub fn get_owner(&self) -> AccountId { self.owner.clone() }
    pub fn is_paused(&self) -> bool { self.paused }
    pub fn get_policy(&self, agent: AccountId) -> Option<Policy> { self.agents.get(&agent).map(|a| a.policy.clone()) }
    pub fn get_spent_today(&self, agent: AccountId) -> U128 {
        U128(self.agents.get(&agent).filter(|a| a.day == Self::day()).map_or(0, |a| a.spent))
    }
    /// Includes expired entries until expire() or an automatic sweep removes them.
    pub fn list_pending(&self) -> Vec<Request> { self.pending.values().cloned().collect() }
    /// `from` is an absolute event sequence, not an index into the retained ring.
    pub fn get_audit(&self, from: U64, limit: u32) -> Vec<Audit> {
        self.audit.iter().filter(|a| a.id.0 >= from.0).take(limit.min(MAX_AUDIT as u32) as usize).cloned().collect()
    }
}

impl SpendGuard {
    fn assert_owner(&self) { assert_eq!(env::predecessor_account_id(), self.owner, "E_OWNER"); }
    fn day() -> u64 { env::block_timestamp() / DAY_NS }
    fn allocate_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("E_OVERFLOW");
        id
    }
    fn validate_policy(p: &Policy) {
        assert!(p.per_tx_max.0 > 0 && p.daily_max.0 > 0, "E_POLICY");
        assert!(p.per_tx_max.0 <= p.daily_max.0, "E_POLICY");
        assert!(p.approval_threshold.0 <= p.per_tx_max.0, "E_POLICY");
        assert!(p.allowlist.len() <= 32, "E_ALLOWLIST_LIMIT");
    }
    fn set_agent_pause(&mut self, agent: AccountId, paused: bool) {
        self.assert_owner();
        self.agents.get_mut(&agent).expect("E_NOT_AGENT").policy.paused = paused;
        self.record(if paused { "agent_paused" } else { "agent_unpaused" }, [("agent", agent.to_string())]);
    }
    fn validate_spend(&self, agent: &AccountId, receiver: &AccountId, amount: u128, reserved: bool) {
        let a = self.agents.get(agent).expect("E_NOT_AGENT");
        assert!(!self.paused && !a.policy.paused, "E_PAUSED");
        assert!(amount > 0, "E_AMOUNT");
        assert!(a.policy.allowlist.contains(receiver), "E_NOT_ALLOWLISTED");
        assert!(amount <= a.policy.per_tx_max.0, "E_PER_TX");
        let spent = if a.day == Self::day() { a.spent } else { 0 };
        let total = if reserved { spent } else { spent.checked_add(amount).expect("E_DAILY") };
        assert!(total <= a.policy.daily_max.0, "E_DAILY");
    }
    fn ensure_liquid(&self, amount: u128) {
        // Retain current storage stake plus headroom for this call's bounded state growth.
        let storage = (u128::from(env::storage_usage()) + 65_536) * env::storage_byte_cost().as_yoctonear();
        let required = self.reserved.checked_add(amount).and_then(|n| n.checked_add(storage)).expect("E_BALANCE");
        assert!(env::account_balance().as_yoctonear() >= required, "E_BALANCE");
    }
    fn transfer(&mut self, id: u64, agent: AccountId, receiver: AccountId, amount: u128, generation: u64, day: u64) {
        self.transfers.insert(id, Transfer { agent, generation, day, amount });
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount)).then(
            Promise::new(env::current_account_id()).function_call(
                "on_transfer".into(), serde_json::to_vec(&serde_json::json!({ "transfer_id": U64(id) })).unwrap(),
                NearToken::from_yoctonear(0), CALLBACK_GAS,
            )
        );
    }
    fn rollback(&mut self, agent: &AccountId, generation: u64, day: u64, amount: u128) {
        if let Some(a) = self.agents.get_mut(agent) {
            if a.generation == generation && a.day == day { a.spent = a.spent.checked_sub(amount).expect("E_ACCOUNTING"); }
        }
    }
    fn release_request(&mut self, id: u64, event: &str) {
        let r = self.pending.remove(&id).expect("E_REQUEST");
        self.reserved -= r.amount.0;
        self.rollback(&r.agent, r.generation.0, r.day.0, r.amount.0);
        self.record(event, [("request_id", id.to_string()), ("agent", r.agent.to_string()), ("amount", r.amount.0.to_string())]);
    }
    fn sweep_expired(&mut self) {
        let ids: Vec<_> = self.pending.values().filter(|r| r.expires_at.0 <= env::block_timestamp()).map(|r| r.id.0).collect();
        for id in ids { self.release_request(id, "expired"); }
    }
    fn record<const N: usize>(&mut self, event: &str, fields: [(&str, String); N]) {
        let data: BTreeMap<String, String> = fields.into_iter().map(|(k, v)| (k.into(), v)).collect();
        let item = Audit { id: U64(self.next_event), timestamp: U64(env::block_timestamp()), event: event.into(), data };
        self.next_event += 1;
        env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({
            "standard": "agent_spend_guard", "version": "1.0.0", "event": event, "data": [&item]
        })));
        if self.audit.len() == MAX_AUDIT { self.audit.pop_front(); }
        self.audit.push_back(item);
    }
}

#[cfg(test)]
mod tests;
