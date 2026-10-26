"""Size ceilings for write bodies that were bounded only by the request body limit.

Each ceiling is a deliberate exception to the contract's "do not tighten input validation"
rule (docs/standards/api/contrato-v1.md, 2.28.0). Values already stored above a ceiling stay
readable; only new writes are limited.
"""

MAX_SEGMENT_TEXT = 20000
MAX_PERSON_NOTES = 4000
MAX_EMAIL = 254
MAX_COLLECTION_NAME = 200
MAX_COLLECTION_DESCRIPTION = 2000
MAX_RECORDING_TAGS = 50
MAX_RECORDING_TAG_LENGTH = 64
MAX_RECORDING_COLLECTIONS = 100
MAX_METADATA_ENTRIES = 50
MAX_METADATA_KEY_LENGTH = 64
MAX_METADATA_VALUE_LENGTH = 1000
MAX_ALLOWED_TOOLS = 100
MAX_TOOL_NAME_LENGTH = 64
