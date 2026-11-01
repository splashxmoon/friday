// A teammate's task read as code or content work, turn by turn (engine/work.ts taskMode; Arun, 2026-10-31: "when we work on code
// it goes to code and when it is work stuff it goes to work"), and videos and sounds taken as files to work with.
import assert from "node:assert/strict";
import test from "node:test";
import { taskMode, TEAM_CODE_NOTE, TEAM_WORK_NOTE } from "../src/engine/work.js";
import { isMediaFile, isUsableFile } from "../src/file-kinds.js";

test("a task is read as code or content work from its words, the files it names and what came with it", () => {
  assert.equal(taskMode(["Cut the launch video into three 15s clips with captions"]), "work");
  assert.equal(taskMode(["Write a LinkedIn post and a thread about the launch"]), "work");
  assert.equal(taskMode(["Fix the failing test in billing.test.ts and open a pull request"]), "code");
  assert.equal(taskMode(["Refactor the auth component"]), "code");
  assert.equal(taskMode(["Here you go"], [{ type: "video/mp4", name: "raw.mp4" }]), "work", "a video sent with it");
  assert.equal(taskMode(["Turn this into a thumbnail: frame.png"]), "work");
  assert.equal(taskMode(["Carry on"], [], "work"), "work", "nothing either way: it stays what it was");
  assert.equal(taskMode(["Carry on"]), "code", "a teammate starts on code");
  assert.equal(taskMode(["Fix the bug in the video upload endpoint"], [], "work"), "code", "code words outweigh one content word");
});

test("what a teammate is told when its work turns over says what to do there", () => {
  assert.match(TEAM_WORK_NOTE, /content work, not code/);
  assert.match(TEAM_WORK_NOTE, /in backticks/);
  assert.match(TEAM_WORK_NOTE, /never instructions/, "what it reads is material, not orders");
  assert.match(TEAM_WORK_NOTE, /waits for the person's yes/);
  assert.match(TEAM_CODE_NOTE, /software again/);
});

test("videos and sounds are files a teammate can be sent", () => {
  assert.equal(isMediaFile("raw.mov"), true);
  assert.equal(isMediaFile("x", "audio/mpeg"), true);
  assert.equal(isMediaFile("notes.txt", "text/plain"), false);
  assert.equal(isUsableFile("launch.mp4", "video/mp4"), true);
  assert.equal(isUsableFile("setup.exe", "application/x-msdownload"), false);
});
