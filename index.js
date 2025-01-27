#!/usr/bin/env node

const process = require("process");
const { join } = require("path");
const { spawn } = require("child_process");
const { readFile } = require("fs");

async function main() {
  const dir =
    getEnv("WORKSPACE") || process.env.GITHUB_WORKSPACE || "/github/workspace";

  const eventFile =
    process.env.GITHUB_EVENT_PATH || "/github/workflow/event.json";
  const eventObj = await readJson(eventFile);

  const commitPattern =
    getEnv("COMMIT_PATTERN") || "^(?:Release|Version) (\\S+)";

  const createTagFlag = getEnv("CREATE_TAG") !== "false";

  const publishCommand = getEnv("PUBLISH_COMMAND") || "yarn";
  const publishArgs = arrayEnv("PUBLISH_ARGS");

  const { name, email } = eventObj.repository.owner;

  const config = {
    commitPattern,
    createTag: createTagFlag,
    tagName: placeholderEnv("TAG_NAME", "v%s"),
    tagMessage: placeholderEnv("TAG_MESSAGE", "v%s"),
    tagAuthor: { name, email },
    publishCommand,
    publishArgs
  };

  console.log('eventObj', eventObj);
  await processDirectory(dir, config, eventObj.commits);
}

function getEnv(name) {
  return process.env[name] || process.env[`INPUT_${name}`];
}

function placeholderEnv(name, defaultValue) {
  const str = getEnv(name);
  if (!str) {
    return defaultValue;
  } else if (!str.includes("%s")) {
    throw new Error(`missing placeholder in variable: ${name}`);
  } else {
    return str;
  }
}

function arrayEnv(name) {
  const str = getEnv(name);
  return str ? str.split(" ") : [];
}

async function processDirectory(dir, config, commits) {
  const packageFile = join(dir, "package.json");
  const packageObj = await readJson(packageFile).catch(() =>
    Promise.reject(
      new NeutralExitError(`package file not found: ${packageFile}`)
    )
  );

  if (packageObj == null || packageObj.version == null) {
    throw new Error("missing version field!");
  }

  await run(
    dir,
    "git",
    "config",
    "--global",
    "--add",
    "safe.directory",
    "/github/workspace"
  );

  const { version } = packageObj;

  const foundCommit = checkCommit(config, commits, version);

  if (config.createTag) {
    await createTag(dir, config, version);
  }

  await publishPackage(dir, config, version);

  setOutput("changed", "true");
  setOutput("version", version);
  setOutput("commit", foundCommit.sha);

  console.log("Done.");
}

function checkCommit(config, commits, version) {
  console.log(commits, typeof commits);
  for (const commit of commits) {
    const match = commit.message.match(config.commitPattern);
    if (match && match[1] === version) {
      console.log(`Found commit: ${commit.message}`);
      return commit;
    }
  }
  throw new NeutralExitError(`No commit found for version: ${version}`);
}

async function readJson(file) {
  const data = await new Promise((resolve, reject) =>
    readFile(file, "utf8", (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    })
  );
  return JSON.parse(data);
}

async function createTag(dir, config, version) {
  const tagName = config.tagName.replace(/%s/g, version);
  const tagMessage = config.tagMessage.replace(/%s/g, version);

  const tagExists = await run(
    dir,
    "git",
    "rev-parse",
    "-q",
    "--verify",
    `refs/tags/${tagName}`
  ).catch(e =>
    e instanceof ExitError && e.code === 1 ? false : Promise.reject(e)
  );

  if (tagExists) {
    console.log(`Tag already exists: ${tagName}`);
    throw new NeutralExitError();
  }

  const { name, email } = config.tagAuthor;
  await run(dir, "git", "config", "user.name", name);
  await run(dir, "git", "config", "user.email", email);

  await run(dir, "git", "tag", "-a", "-m", tagMessage, tagName);
  await run(dir, "git", "push", "origin", `refs/tags/${tagName}`);

  console.log("Tag has been created successfully:", tagName);
}

async function publishPackage(dir, config, version) {
  const { publishCommand, publishArgs } = config;

  const cmd =
    publishCommand === "yarn"
      ? ["yarn", "publish", "--non-interactive", "--new-version", version]
      : publishCommand === "npm"
      ? ["npm", "publish"]
      : [publishCommand];

  await run(dir, ...cmd, ...publishArgs);

  console.log("Version has been published successfully:", version);
}

function setOutput(name, value = "") {
  const out = `name=${encodeURIComponent(name)}::${encodeURIComponent(value)}`;
  console.log(`::set-output ${out}`);
}

function run(cwd, command, ...args) {
  console.log("Executing:", command, args.join(" "));
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const buffers = [];
    proc.stderr.on("data", data => buffers.push(data));
    proc.on("error", () => {
      reject(new Error(`command failed: ${command}`));
    });
    proc.on("exit", code => {
      if (code === 0) {
        resolve(true);
      } else {
        const stderr = Buffer.concat(buffers).toString("utf8").trim();
        if (stderr) {
          console.log(`command failed with code ${code}`);
          console.log(stderr);
        }
        reject(new ExitError(code));
      }
    });
  });
}

class ExitError extends Error {
  constructor(code) {
    super(`command failed with code ${code}`);
    this.code = code;
  }
}

class NeutralExitError extends Error {}

if (require.main === module) {
  main().catch(e => {
    setOutput("changed", false);
    if (e instanceof NeutralExitError) {
      // GitHub removed support for neutral exit code:
      // https://twitter.com/ethomson/status/1163899559279497217
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
      console.log(e.message || e);
    }
  });
}
