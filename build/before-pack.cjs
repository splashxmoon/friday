// Before each app is packed: the pty binary for its chip (pty-arch.cjs).
exports.default = async (context) => require("./pty-arch.cjs").before(context);
