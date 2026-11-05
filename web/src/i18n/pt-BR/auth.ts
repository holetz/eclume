import type en from '../en/auth'
import type { Catalog } from '../locale'

const auth: Catalog<typeof en> = {
  layout: {
    user: {
      title: 'Cada palavra, guardada no seu servidor.',
      tagline: 'Transcrição auto-hospedada para as suas próprias gravações.',
    },
    admin: {
      title: 'Painel de administração',
      tagline: 'Separado das contas de usuário. Só configurações da plataforma.',
    },
  },
  email: 'E-mail',
  password: 'Senha',
  passwordHint: 'Pelo menos {{min}} caracteres.',
  login: {
    title: 'Entrar',
    submit: 'Entrar',
    submitting: 'Entrando…',
    wrongCredentials: 'E-mail ou senha incorretos.',
    forgot: 'Esqueceu a senha? Peça um link a quem administra o servidor.',
    noAccount: 'Não tem conta?',
    signup: 'Criar conta',
  },
  notice: {
    pageTitle: 'Aceite do aviso',
    title: 'Antes de continuar',
    text: 'O aviso do eclume mudou. Para usar a sua conta, aceite a versão em vigor.',
    loading: 'Carregando o aviso…',
    submit: 'Aceitar e continuar',
    submitting: 'Registrando…',
    logout: 'Sair',
    loggingOut: 'Saindo…',
  },
  reset: {
    title: 'Redefinir a senha',
    invalid: 'Este link venceu ou já foi usado. Peça outro a quem administra o servidor.',
    done: 'Senha redefinida. Entre com a nova.',
    back: 'Voltar para a entrada',
    account: 'Conta <email>{{email}}</email>. Ao redefinir, as sessões abertas desta conta são encerradas.',
    newPassword: 'Nova senha',
    repeat: 'Repita a nova senha',
    mismatch: 'As senhas não conferem.',
    submit: 'Redefinir a senha',
    submitting: 'Redefinindo…',
  },
  signup: {
    pageTitle: 'Criar conta',
    title: 'Criar sua conta',
    closed: 'O cadastro está fechado neste servidor. Peça uma conta a quem o administra.',
    text: 'Seu espaço fica pronto assim que você se cadastra.',
    name: 'Nome',
    emailTaken: 'Já existe uma conta com este e-mail.',
    haveAccount: 'Já tem conta?',
    login: 'Entrar',
    submit: 'Criar conta',
    submitting: 'Criando…',
    missing: 'Para criar a conta, falta {{items}}.',
    missingName: 'o nome',
    missingEmail: 'o e-mail',
    missingPassword: 'a senha com {{min}} caracteres',
    missingAccepted: 'o aceite do aviso',
    destination: {
      summaries: 'Neste servidor, os resumos são feitos fora dele, por {{who}}: o texto das transcrições vai para lá. O áudio e as transcrições ficam guardados aqui.',
      chat: 'Neste servidor, o chat são feitos fora dele, por {{who}}: o texto das transcrições vai para lá. O áudio e as transcrições ficam guardados aqui.',
      both: 'Neste servidor, os resumos e o chat são feitos fora dele, por {{who}}: o texto das transcrições vai para lá. O áudio e as transcrições ficam guardados aqui.',
      unknownProcessor: 'um serviço externo',
    },
  },
}

export default auth
