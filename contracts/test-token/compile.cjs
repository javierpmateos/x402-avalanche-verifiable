const solc = require("solc"); const fs = require("fs");
const input = { language: "Solidity", sources: { "C.sol": { content: fs.readFileSync(__dirname + "/TestTokens.sol", "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) for (const e of out.errors) if (e.severity === "error") { console.error(e.formattedMessage); process.exit(1); }
const c = out.contracts["C.sol"];
fs.writeFileSync(__dirname + "/artifacts.json", JSON.stringify({
  TestUSDC: { abi: c.TestUSDC.abi, bytecode: "0x" + c.TestUSDC.evm.bytecode.object },
  MiniMulticall3: { abi: c.MiniMulticall3.abi, deployed: "0x" + c.MiniMulticall3.evm.deployedBytecode.object },
}, null, 1));
console.log("ok", c.TestUSDC.evm.bytecode.object.length);
