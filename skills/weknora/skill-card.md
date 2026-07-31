## Description: <br>
Import documents and perform knowledge retrieval via the WeKnora API for uploading files, URLs, or Markdown to a knowledge base, performing hybrid retrieval, and querying knowledge details. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[lyingbug](https://clawhub.ai/user/lyingbug) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and operators use this skill to manage WeKnora knowledge bases from an agent, including document import, content browsing, and hybrid search across knowledge bases. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The WeKnora API key may allow an agent to create, edit, and delete knowledge-base content. <br>
Mitigation: Confirm edit and deletion targets explicitly before running those calls, and install the skill only when knowledge-base management is intended. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/lyingbug/skills/weknora) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with bash and JSON examples] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Requires WEKNORA_BASE_URL and WEKNORA_API_KEY before API calls.] <br>

## Skill Version(s): <br>
1.0.1 (source: server-resolved release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
