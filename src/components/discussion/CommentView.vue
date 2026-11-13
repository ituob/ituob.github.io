<script setup lang="ts">
import { commentText, type DiscussionComment } from '../../lib/discussion-client';
defineProps<{ comment: DiscussionComment; canEdit: boolean; canReply: boolean; admin: boolean; disabled: boolean }>();
defineEmits<{ reply: [comment: DiscussionComment]; edit: [comment: DiscussionComment]; remove: [comment: DiscussionComment]; restore: [comment: DiscussionComment] }>();
</script>
<template>
  <article :id="`comment-${comment.id}`" :aria-label="`Comment by ${comment.author_id}`">
    <p><strong>{{ comment.kind === 'system' ? 'System' : comment.author_id }}</strong> · {{ comment.created_at }} · Revision {{ comment.current_rev }}
      <span v-if="comment.affiliation_kind"> · {{ comment.affiliation_kind === 'itu' ? 'ITU' : 'Member delegation' }}<span v-if="comment.affiliation_member_id">: {{ comment.affiliation_member_id }}</span></span>
    </p>
    <p v-if="comment.parent_id">Reply to <a :href="`#comment-${comment.parent_id}`">{{ comment.parent_id }}</a></p>
    <p v-if="comment.anchor_path || comment.anchor_line">On submission revision {{ comment.anchor_rev }}: {{ comment.anchor_path || 'document' }}<span v-if="comment.anchor_line">, line {{ comment.anchor_line }}</span></p>
    <blockquote v-if="comment.anchor_quote">{{ comment.anchor_quote }}</blockquote>
    <p class="body">{{ commentText(comment) }}</p>
    <p v-if="comment.deleted_at">Removed {{ comment.deleted_at }}<span v-if="comment.delete_reason">: {{ comment.delete_reason }}</span></p>
    <button v-if="canReply" :disabled="disabled" type="button" @click="$emit('reply', comment)">Reply</button>
    <button v-if="canEdit && canReply && !comment.deleted_at && comment.kind === 'comment'" :disabled="disabled" type="button" @click="$emit('edit', comment)">Edit my comment</button>
    <button v-if="(canEdit || admin) && !comment.deleted_at && comment.kind === 'comment'" :disabled="disabled" type="button" @click="$emit('remove', comment)">{{ admin ? 'Moderate: remove comment' : 'Remove my comment' }}</button>
    <button v-if="admin && comment.deleted_at && comment.kind === 'comment'" :disabled="disabled" type="button" @click="$emit('restore', comment)">Restore comment</button>
    <details v-if="!comment.deleted_at && comment.revisions.length > 1"><summary>Comment revisions</summary><ol><li v-for="revision in comment.revisions" :key="revision.rev">Revision {{ revision.rev }} · {{ revision.created_at }}<p class="body">{{ revision.body }}</p></li></ol></details>
  </article>
</template>
<style scoped>article { border: 1px solid #a8b6c5; padding: 1rem; margin: .75rem 0; } .body { white-space: pre-wrap; overflow-wrap: anywhere; } button { margin: .2rem; border: 1px solid #708397; padding: .35rem; }</style>
