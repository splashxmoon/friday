declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

/** A plain stylesheet imported for its own sake; esbuild folds it into app.css. */
declare module "*.css";
