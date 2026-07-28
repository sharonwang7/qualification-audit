const { connector } = require("./lib/connector-feishu.js");
// 看 #65 谁操作了 approve
const tasks = connector.api("GET", "/open-apis/approval/v4/tasks/search", { user_id: "ou_dc58e9efc5ed5cf4c73d48249d7f8e70", user_id_type: "open_id", instance_code: "B9896CE0-FDB1-4FDF-A201-3BE14CBF668F" }, "bot", { cwd: process.cwd() });
console.log(JSON.stringify(tasks, null, 2).substring(0, 2000));
