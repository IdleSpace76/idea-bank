import {test,expect} from "@playwright/test";
import {exposeLibraryStore} from "./local-fixture";

declare global {
  interface Window { lockEntered:boolean; lockValid:()=>boolean; releaseLock:()=>void; holdingLock:Promise<boolean> }
}

test("fallback sync lease excludes other tabs, recovers expired owners and detects replacement",async({context})=>{
  await context.addInitScript(()=>Object.defineProperty(navigator,"locks",{value:undefined}));
  const first=await context.newPage(),other=await context.newPage();
  for(const page of [first,other]){await exposeLibraryStore(page);await page.goto("/__lock_probe__");}
  await first.evaluate(async()=>{const {withSyncLock}=await import("/__local_fixture__/"+"sync-lock.js");window.lockEntered=false;window.holdingLock=withSyncLock(async(valid:()=>boolean)=>{window.lockEntered=true;window.lockValid=valid;await new Promise<void>(r=>{window.releaseLock=r;});});});
  await expect.poll(()=>first.evaluate(()=>window.lockEntered)).toBe(true);
  expect(await other.evaluate(async()=>{const {withSyncLock}=await import("/__local_fixture__/"+"sync-lock.js");return withSyncLock(async()=>{throw new Error("Overlapping lease");});})).toBe(false);
  await first.evaluate(async()=>{window.releaseLock();await window.holdingLock;});
  expect(await other.evaluate(async()=>{const {withSyncLock}=await import("/__local_fixture__/"+"sync-lock.js");return withSyncLock(async(valid:()=>boolean)=>{if(!valid())throw new Error("Invalid lease");});})).toBe(true);
  await first.evaluate(async()=>{const {transaction}=await import("/__local_fixture__/"+"local-database.js");await transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put({owner:"crashed",expires:Date.now()-1},"sync-lease");});});
  expect(await other.evaluate(async()=>{const {withSyncLock}=await import("/__local_fixture__/"+"sync-lock.js");return withSyncLock(async()=>{});})).toBe(true);
  await first.clock.install();
  await first.evaluate(async()=>{const {withSyncLock}=await import("/__local_fixture__/"+"sync-lock.js");window.holdingLock=withSyncLock(async(valid:()=>boolean)=>{window.lockValid=valid;await new Promise<void>(r=>{window.releaseLock=r;});});});
  await expect.poll(()=>first.evaluate(()=>window.lockValid())).toBe(true);
  await other.evaluate(async()=>{const {transaction}=await import("/__local_fixture__/"+"local-database.js");await transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put({owner:"replacement",expires:Date.now()+180000},"sync-lease");});});
  await first.clock.runFor(10050);await expect.poll(()=>first.evaluate(()=>window.lockValid())).toBe(false);
  await first.evaluate(async()=>{window.releaseLock();await window.holdingLock;});
});
