'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

interface Branch {
  id: string;
  name: string;
  timezone: string | null;
  archived_at: string | null;
  whatsapp_config_id: string | null;
  member_user_ids: string[];
}

interface Member {
  user_id: string;
  full_name: string;
  role: string;
}

export function BranchesPanel() {
  const t = useTranslations('Settings.branches');
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bRes, mRes] = await Promise.all([
        fetch('/api/account/branches', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      if (bRes.ok) {
        const json = (await bRes.json()) as { branches: Branch[] };
        setBranches(json.branches ?? []);
      }
      if (mRes.ok) {
        const json = (await mRes.json()) as { members: Member[] };
        setMembers(json.members ?? []);
      }
    } catch (err) {
      console.error('Failed to load branches:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const grantable = members.filter(
    (m) => m.role === 'agent' || m.role === 'viewer',
  );

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch('/api/account/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('createFailed'));
        return;
      }
      setNewName('');
      toast.success(t('created'));
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(branch: Branch, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === branch.name) return;
    const res = await fetch(`/api/account/branches/${branch.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || t('renameFailed'));
      await load();
      return;
    }
    setBranches((prev) =>
      prev.map((b) => (b.id === branch.id ? { ...b, name: trimmed } : b)),
    );
  }

  async function handleDelete(branch: Branch) {
    if (!confirm(t('deleteConfirm', { name: branch.name }))) return;
    setBusyId(branch.id);
    try {
      const res = await fetch(`/api/account/branches/${branch.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('deleteFailed'));
        return;
      }
      toast.success(t('deleted'));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleMember(branch: Branch, userId: string, next: boolean) {
    const nextIds = next
      ? [...new Set([...branch.member_user_ids, userId])]
      : branch.member_user_ids.filter((id) => id !== userId);
    setBusyId(branch.id);
    try {
      const res = await fetch(`/api/account/branches/${branch.id}/members`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: nextIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('membersFailed'));
        return;
      }
      setBranches((prev) =>
        prev.map((b) =>
          b.id === branch.id ? { ...b, member_user_ids: nextIds } : b,
        ),
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {canEditSettings ? (
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="new-branch">{t('name')}</Label>
            <Input
              id="new-branch"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
          </div>
          <Button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !newName.trim()}
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t('create')}
          </Button>
        </div>
      ) : null}

      {branches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="space-y-3">
          {branches.map((branch) => (
            <Card key={branch.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start gap-2">
                  <Input
                    defaultValue={branch.name}
                    disabled={!canEditSettings}
                    onBlur={(e) => void handleRename(branch, e.target.value)}
                    className="font-medium"
                  />
                  {canEditSettings ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={busyId === branch.id}
                      onClick={() => void handleDelete(branch)}
                      aria-label={t('delete')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {branch.whatsapp_config_id
                    ? t('hasNumber')
                    : t('noNumber')}
                </p>
                {grantable.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('noAgents')}</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground">
                      {t('agents')}
                    </p>
                    {grantable.map((member) => {
                      const checked = branch.member_user_ids.includes(
                        member.user_id,
                      );
                      return (
                        <label
                          key={member.user_id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!canEditSettings || busyId === branch.id}
                            onCheckedChange={(v) =>
                              void handleToggleMember(
                                branch,
                                member.user_id,
                                v === true,
                              )
                            }
                          />
                          <span>
                            {member.full_name || t('unnamed')}
                            <span className="ml-1 text-xs text-muted-foreground">
                              {member.role}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
