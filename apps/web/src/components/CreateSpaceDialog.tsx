import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { ColorSwatches } from './pickers';
import { Button, Checkbox, Field, Input, Modal } from './ui';

export function CreateSpaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [color, setColor] = useState('#6366f1');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoPrefix = (n: string) => n.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 4) || n.slice(0, 3).toUpperCase();
  const effectivePrefix = prefixTouched ? prefix : autoPrefix(name).padEnd(2, 'X');
  const submit = async () => {
    setBusy(true);
    try {
      const s = await api.post<{ id: string }>('/hierarchy/spaces', { name, keyPrefix: effectivePrefix, color, private: priv });
      await qc.invalidateQueries({ queryKey: keys.tree });
      onClose();
      setName(''); setPrefix(''); setPrefixTouched(false); setPriv(false);
      nav(`/s/${s.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New space" width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>Create space</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operations" /></Field>
        <Field label="Task key prefix" hint="— tasks are numbered like OPS-12; used by Gitea links">
          <Input value={effectivePrefix} onChange={(e) => { setPrefixTouched(true); setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); }} />
        </Field>
        <Field label="Color"><ColorSwatches value={color} onChange={setColor} /></Field>
        <Checkbox checked={priv} onChange={setPriv} label="Private — only me (I can share it afterwards)" />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
