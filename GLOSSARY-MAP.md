# Glossary Map

`pumpkin-plugins` is an ecosystem umbrella with distinct domain contexts. The contexts support the
same project goals but have different users, responsibilities, and language. Glossaries are created
only when a context has shared terms worth recording.

## Contexts

- [Pumpkin Plugin API](./GLOSSARY.md), implemented in [`tools/pumpkin-api/`](https://github.com/filiphsps/pumpkin-plugins/tree/master/tools/pumpkin-api):
  defines the host contract that Pumpkin plugins compile against. This is the only context glossary
  currently maintained.
- Plugins in [`packages/`](https://github.com/filiphsps/pumpkin-plugins/tree/master/packages): provide behavior for players and server operators.
- Developer tools in [`tools/`](https://github.com/filiphsps/pumpkin-plugins/tree/master/tools): help authors build, test, document, publish, and maintain
  plugins. Published packages also serve authors working in standalone repositories.
- Reusable GitHub Actions in [`actions/`](https://github.com/filiphsps/pumpkin-plugins/tree/master/actions): automate plugin signing, verification, and
  Market publishing workflows.
- Editor extensions in [`extensions/`](https://github.com/filiphsps/pumpkin-plugins/tree/master/extensions): support authoring workflows around the
  Minecraft ecosystem.

## Relationships

- Plugin packages target Pumpkin's host API and use the developer tools where appropriate.
- GitHub Actions support release and distribution workflows for plugin artifacts.
- Editor extensions support contributors and plugin authors; they are part of the project when they
  materially serve those workflows.
