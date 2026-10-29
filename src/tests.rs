use super::*;
use near_sdk::{test_utils::{VMContextBuilder, get_logs, get_created_receipts}, testing_env, RuntimeFeesConfig};

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn context(who: &str, time: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("guard.test.near"))
        .predecessor_account_id(id(who)).signer_account_id(id(who))
        .block_timestamp(time).account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}
fn callback(success: bool, time: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("guard.test.near"))
        .predecessor_account_id(id("guard.test.near"))
        .block_timestamp(time).account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(),
        std::collections::HashMap::default(), vec![if success { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
}
fn policy() -> Policy {
    Policy { per_tx_max: U128(100), daily_max: U128(200),
        allowlist: vec![id("shop.test.near")], approval_threshold: U128(50), paused: false }
}
fn setup() -> SpendGuard {
    context("guard.test.near", 1);
    let mut c = SpendGuard::new(id("owner.test.near"));
    context("owner.test.near", 1);
    c.add_agent(id("agent.test.near"), policy());
    context("agent.test.near", 1);
    c
}
fn spend(c: &mut SpendGuard, amount: u128) -> SpendResult {
    c.spend(id("shop.test.near"), U128(amount), "test".into())
}
fn pending(c: &mut SpendGuard, amount: u128) -> U64 {
    match spend(c, amount) { SpendResult::Pending { request_id } => request_id, _ => panic!("expected pending") }
}
fn transferring(c: &mut SpendGuard, amount: u128) -> U64 {
    match spend(c, amount) { SpendResult::Transferring { transfer_id } => transfer_id, _ => panic!("expected transfer") }
}
fn fails(f: impl FnOnce(), code: &str) {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected error");
    let msg = e.downcast_ref::<String>().map(String::as_str)
        .or_else(|| e.downcast_ref::<&str>().copied()).unwrap_or("");
    assert!(msg.contains(code), "expected {code}, got {msg}");
}

#[test]
fn direct_transfer_and_threshold_boundary() {
    let mut c = setup();
    transferring(&mut c, 50);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 50);
    assert!(c.list_pending().is_empty());
    assert_eq!(get_created_receipts().len(), 2);
}

#[test]
fn allowlist_and_empty_allowlist_deny() {
    let mut c = setup();
    fails(|| { c.spend(id("evil.test.near"), U128(1), "".into()); }, "E_NOT_ALLOWLISTED");
    context("owner.test.near", 1);
    let mut p = policy(); p.allowlist.clear();
    c.update_policy(id("agent.test.near"), p);
    context("agent.test.near", 1);
    fails(|| { spend(&mut c, 1); }, "E_NOT_ALLOWLISTED");
}

#[test]
fn hard_caps_include_pending() {
    let mut c = setup();
    fails(|| { spend(&mut c, 101); }, "E_PER_TX");
    pending(&mut c, 100); pending(&mut c, 100);
    fails(|| { spend(&mut c, 1); }, "E_DAILY");
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 200);
    assert_eq!(c.reserved, 200);
}

#[test]
fn utc_rollover_sweeps_old_pending() {
    let mut c = setup(); pending(&mut c, 100);
    context("agent.test.near", DAY_NS - 1);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 100);
    context("agent.test.near", DAY_NS);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 0);
    transferring(&mut c, 50);
    assert!(c.list_pending().is_empty());
    assert_eq!(c.reserved, 0);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 50);
}

#[test]
fn threshold_reserves_without_receipt() {
    let mut c = setup(); let request_id = pending(&mut c, 51);
    assert!(get_created_receipts().is_empty());
    let r = &c.list_pending()[0];
    assert_eq!(r.id, request_id);
    assert_eq!(r.expires_at.0, DAY_NS);
    assert_eq!(r.created_at.0, 1);
    assert_eq!(r.memo, "test");
    assert_eq!(c.reserved, 51);
}

#[test]
fn approve_retains_daily_charge_and_releases_balance_reserve() {
    let mut c = setup(); let request_id = pending(&mut c, 100);
    context("owner.test.near", 2);
    assert_eq!(c.approve(request_id), request_id);
    assert_eq!(c.reserved, 0);
    assert!(c.list_pending().is_empty());
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 100);
    assert_eq!(get_created_receipts().len(), 2);
    fails(|| { c.approve(request_id); }, "E_REQUEST");
}

#[test]
fn reject_releases_budget() {
    let mut c = setup(); let request_id = pending(&mut c, 100);
    context("owner.test.near", 2); c.reject(request_id);
    assert_eq!(c.reserved, 0);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 0);
    context("agent.test.near", 3); pending(&mut c, 100);
}

#[test]
fn expiry_is_permissionless_and_cannot_be_approved() {
    let mut c = setup(); let request_id = pending(&mut c, 100);
    fails(|| c.expire(request_id), "E_NOT_EXPIRED");
    context("owner.test.near", DAY_NS);
    fails(|| { c.approve(request_id); }, "E_EXPIRED");
    context("stranger.test.near", DAY_NS);
    c.expire(request_id);
    assert!(c.list_pending().is_empty());
    assert_eq!(c.reserved, 0);
}

#[test]
fn global_and_agent_pause_block_spend_and_approval() {
    let mut c = setup(); let request_id = pending(&mut c, 100);
    context("owner.test.near", 1); c.pause();
    fails(|| { c.approve(request_id); }, "E_PAUSED");
    context("agent.test.near", 1);
    fails(|| { spend(&mut c, 1); }, "E_PAUSED");
    context("owner.test.near", 1); c.unpause(); c.pause_agent(id("agent.test.near"));
    fails(|| { c.approve(request_id); }, "E_PAUSED");
    context("agent.test.near", 1);
    fails(|| { spend(&mut c, 1); }, "E_PAUSED");
    context("owner.test.near", 1); c.unpause_agent(id("agent.test.near"));
    c.approve(request_id);
}

#[test]
fn non_agent_and_forwarded_calls_rejected() {
    let mut c = setup(); context("stranger.test.near", 1);
    fails(|| { spend(&mut c, 1); }, "E_NOT_AGENT");
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("guard.test.near")).predecessor_account_id(id("agent.test.near"))
        .signer_account_id(id("stranger.test.near"));
    testing_env!(b.build());
    fails(|| { spend(&mut c, 1); }, "E_NOT_AGENT");
}

#[test]
fn all_owner_methods_reject_non_owner() {
    let mut c = setup(); let r = pending(&mut c, 100);
    fails(|| c.add_agent(id("other.test.near"), policy()), "E_OWNER");
    fails(|| c.update_policy(id("agent.test.near"), policy()), "E_OWNER");
    fails(|| c.remove_agent(id("agent.test.near")), "E_OWNER");
    fails(|| c.pause(), "E_OWNER"); fails(|| c.unpause(), "E_OWNER");
    fails(|| c.pause_agent(id("agent.test.near")), "E_OWNER");
    fails(|| c.unpause_agent(id("agent.test.near")), "E_OWNER");
    fails(|| { c.approve(r); }, "E_OWNER"); fails(|| c.reject(r), "E_OWNER");
    fails(|| { c.withdraw(U128(1)); }, "E_OWNER");
    fails(|| { c.clear_stale_transfer(U64(0)); }, "E_OWNER");
}

#[test]
fn failed_transfer_rolls_back_once_success_does_not() {
    let mut c = setup(); let first = transferring(&mut c, 50);
    callback(false, 1); assert!(!c.on_transfer(first));
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 0);
    fails(|| { c.on_transfer(first); }, "E_TRANSFER");
    context("agent.test.near", 2); let second = transferring(&mut c, 50);
    callback(true, 2); assert!(c.on_transfer(second));
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 50);
}

#[test]
fn failed_approved_transfer_releases_daily_charge() {
    let mut c = setup(); let r = pending(&mut c, 100);
    context("owner.test.near", 1); c.approve(r);
    callback(false, 1); c.on_transfer(r);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 0);
    assert_eq!(c.reserved, 0);
}

#[test]
fn old_callback_cannot_reduce_new_day() {
    let mut c = setup(); let old = transferring(&mut c, 50);
    context("agent.test.near", DAY_NS); transferring(&mut c, 25);
    callback(false, DAY_NS); c.on_transfer(old);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 25);
}

#[test]
fn removal_cancels_pending_and_isolates_old_callback() {
    let mut c = setup(); let old = transferring(&mut c, 50); pending(&mut c, 100);
    context("owner.test.near", 1); c.remove_agent(id("agent.test.near"));
    assert_eq!(c.reserved, 0); assert!(c.list_pending().is_empty());
    assert!(c.get_policy(id("agent.test.near")).is_none());
    c.add_agent(id("agent.test.near"), policy());
    context("agent.test.near", 1); transferring(&mut c, 20);
    callback(false, 1); c.on_transfer(old);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 20);
}

#[test]
fn callback_is_private_and_requires_one_result() {
    let mut c = setup(); let t = transferring(&mut c, 1);
    fails(|| { c.on_transfer(t); }, "E_PRIVATE");
    context("guard.test.near", 1);
    fails(|| { c.on_transfer(t); }, "E_CALLBACK");
}

#[test]
fn approval_revalidates_updated_policy_without_resetting_spend() {
    let mut c = setup(); let r = pending(&mut c, 100);
    context("owner.test.near", 1);
    let mut p = policy(); p.allowlist.clear(); c.update_policy(id("agent.test.near"), p);
    fails(|| { c.approve(r); }, "E_NOT_ALLOWLISTED");
    let mut p = policy(); p.per_tx_max = U128(90); c.update_policy(id("agent.test.near"), p);
    fails(|| { c.approve(r); }, "E_PER_TX");
    let mut p = policy(); p.per_tx_max = U128(90); p.daily_max = U128(90);
    c.update_policy(id("agent.test.near"), p);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 100);
    c.reject(r);
}

#[test]
fn audit_is_bounded_paginated_and_nep297() {
    let mut c = setup(); context("owner.test.near", 1);
    for _ in 0..140 { context("owner.test.near", 1); c.pause(); }
    let all = c.get_audit(U64(0), 999);
    assert_eq!(all.len(), MAX_AUDIT);
    assert!(all[0].id.0 > 0);
    assert_eq!(c.get_audit(all[0].id, 2).len(), 2);
    assert!(c.get_audit(U64(0), 0).is_empty());
    let logs = get_logs();
    let value: serde_json::Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(value["standard"], "agent_spend_guard");
    assert_eq!(value["version"], "1.0.0"); assert!(value["data"].is_array());
}

#[test]
fn invalid_amount_memo_policy_and_duplicate_agent() {
    let mut c = setup(); fails(|| { spend(&mut c, 0); }, "E_AMOUNT");
    fails(|| { c.spend(id("shop.test.near"), U128(1), "x".repeat(257)); }, "E_MEMO");
    context("owner.test.near", 1);
    fails(|| c.add_agent(id("agent.test.near"), policy()), "E_AGENT_EXISTS");
    let mut p = policy(); p.approval_threshold = U128(101);
    fails(|| c.update_policy(id("agent.test.near"), p), "E_POLICY");
    fails(|| c.add_agent(id("owner.test.near"), policy()), "E_OWNER_IS_AGENT");
    fails(|| c.add_agent(id("guard.test.near"), policy()), "E_CONTRACT_IS_AGENT");
}

#[test]
fn liquidity_protects_pending_and_storage_from_withdrawal() {
    let mut c = setup(); pending(&mut c, 100);
    context("owner.test.near", 1);
    let available = env::account_balance().as_yoctonear()
        - (u128::from(env::storage_usage()) + 65_536) * env::storage_byte_cost().as_yoctonear();
    fails(|| { c.withdraw(U128(available)); }, "E_BALANCE");
    drop(c.withdraw(U128(available - 100)));
    assert_eq!(c.reserved, 100);
}

#[test]
fn init_only_by_contract_account() {
    // Front-running: a stranger (or the owner itself) cannot initialize the contract.
    context("stranger.test.near", 1);
    fails(|| { SpendGuard::new(id("stranger.test.near")); }, "E_PRIVATE");
    context("owner.test.near", 1);
    fails(|| { SpendGuard::new(id("owner.test.near")); }, "E_PRIVATE");
    context("guard.test.near", 1);
    fails(|| { SpendGuard::new(id("guard.test.near")); }, "E_OWNER_IS_CONTRACT");
    assert_eq!(SpendGuard::new(id("owner.test.near")).get_owner(), id("owner.test.near"));
}

const LONG_AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.test.near";
fn full_pending_with_long_ids() -> SpendGuard {
    assert_eq!(LONG_AGENT.len(), 64);
    context("guard.test.near", 1);
    let mut c = SpendGuard::new(id("owner.test.near"));
    context("owner.test.near", 1);
    let shop = "ssssssssssssssssssssssssssssssssssssssssssssssssssssss.test.near";
    let p = Policy { per_tx_max: U128(10u128.pow(24)), daily_max: U128(10u128.pow(27)),
        allowlist: vec![id(shop)], approval_threshold: U128(0), paused: false };
    c.add_agent(id(LONG_AGENT), p);
    for _ in 0..MAX_PENDING {
        context(LONG_AGENT, 1);
        match c.spend(id(shop), U128(10u128.pow(23) + 123_456_789), "m".repeat(MAX_MEMO)) {
            SpendResult::Pending { .. } => {}, _ => panic!("expected pending"),
        }
    }
    assert_eq!(c.list_pending().len(), MAX_PENDING);
    c
}

#[test]
fn removal_at_max_pending_fits_log_limit() {
    // The mocked VM enforces the protocol's 16 KiB total log limit.
    let mut c = full_pending_with_long_ids();
    context("owner.test.near", 2);
    c.remove_agent(id(LONG_AGENT));
    assert!(c.list_pending().is_empty());
    assert_eq!(c.reserved, 0);
    let total: usize = get_logs().iter().map(String::len).sum();
    assert!(total < 16_384, "logs {total} bytes");
}

#[test]
fn sweep_is_bounded_and_expire_handles_rest() {
    let mut c = full_pending_with_long_ids();
    context("owner.test.near", DAY_NS + 1);
    drop(c.withdraw(U128(1)));
    assert_eq!(c.list_pending().len(), MAX_PENDING - MAX_SWEEP);
    let total: usize = get_logs().iter().map(String::len).sum();
    assert!(total < 16_384, "logs {total} bytes");
    for r in c.list_pending() { context("stranger.test.near", DAY_NS + 1); c.expire(r.id); }
    assert!(c.list_pending().is_empty());
    assert_eq!(c.reserved, 0);
}

#[test]
fn stale_transfer_can_be_cleared_only_after_its_day() {
    let mut c = setup(); let t = transferring(&mut c, 50);
    assert_eq!(c.list_transfers(), vec![t]);
    context("owner.test.near", DAY_NS - 1);
    fails(|| c.clear_stale_transfer(t), "E_NOT_STALE");
    context("owner.test.near", DAY_NS);
    c.clear_stale_transfer(t);
    assert!(c.list_transfers().is_empty());
    fails(|| c.clear_stale_transfer(t), "E_TRANSFER");
    // A late callback for a cleared entry fails instead of touching the budget.
    callback(false, DAY_NS);
    fails(|| { c.on_transfer(t); }, "E_TRANSFER");
}

#[test]
fn approve_after_removal_and_daily_cap_reduction() {
    let mut c = setup(); let r = pending(&mut c, 100);
    context("owner.test.near", 1);
    let mut p = policy(); p.daily_max = U128(99); p.per_tx_max = U128(99); p.approval_threshold = U128(50);
    c.update_policy(id("agent.test.near"), p);
    fails(|| { c.approve(r); }, "E_PER_TX");
    let mut p = policy(); p.daily_max = U128(150); c.update_policy(id("agent.test.near"), p);
    context("agent.test.near", 1);
    fails(|| { spend(&mut c, 51); }, "E_DAILY");
    context("owner.test.near", 1);
    c.remove_agent(id("agent.test.near"));
    fails(|| { c.approve(r); }, "E_REQUEST");
}

#[test]
fn approval_fails_daily_after_daily_cap_reduction() {
    let mut c = setup(); let a = pending(&mut c, 60); pending(&mut c, 60);
    context("owner.test.near", 1);
    let mut p = policy(); p.daily_max = U128(100); c.update_policy(id("agent.test.near"), p);
    fails(|| { c.approve(a); }, "E_DAILY");
    c.reject(a);
    assert_eq!(c.get_spent_today(id("agent.test.near")).0, 60);
}
